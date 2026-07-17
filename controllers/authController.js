// controllers/authController.js
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import User from "../models/User.js";

const generateToken = (user) =>
  jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: "7d" });

const getCookieOptions = () => {
  const isProd = process.env.NODE_ENV === "production";
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? "none" : "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  };
};

const publicUser = (user) => ({
  id: user._id,
  fullName: user.fullName,
  email: user.email || null,
  phone: user.phone || null,
  isAdmin: user.isAdmin,
  role: user.role,
});

// @desc    Authenticate any user (customer, kitchen, waiter, accountant, admin)
//          by email or phone — cookie-based session, like MarinePanel
// @route   POST /api/auth/login
// @access  Public
export const login = async (req, res) => {
  try {
    const { identifier, password } = req.body;

    if (!identifier || !password) {
      return res.status(400).json({ message: "Enter your email/phone and password" });
    }

    const value = identifier.trim().toLowerCase();

    const user = await User.findOne({
      $or: [{ email: value }, { phone: identifier.trim() }],
    });

    if (!user || !user.isActive) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const token = generateToken(user);
    res.cookie("token", token, getCookieOptions());

    res.json({ user: publicUser(user) });
  } catch (error) {
    console.error("Login error:", error.message);
    res.status(500).json({ message: "Server error" });
  }
};

// @desc    Clear the session cookie
// @route   POST /api/auth/logout
// @access  Public
export const logout = async (req, res) => {
  res.clearCookie("token", getCookieOptions());
  res.json({ message: "Logged out" });
};

// @desc    Return the logged-in user — frontend calls this on load since the
//          token lives in an httpOnly cookie and can't be read by JS directly
// @route   GET /api/auth/me
// @access  Protected
export const getMe = async (req, res) => {
  res.json({ user: publicUser(req.user) });
};

// @desc    Check if an email/phone is already taken — used for live signup validation
// @route   GET /api/auth/check-availability?field=email&value=jane@mail.com
// @access  Public
export const checkAvailability = async (req, res) => {
  try {
    const { field, value } = req.query;

    if (!field || !value || !["email", "phone"].includes(field)) {
      return res.status(400).json({ message: "Invalid check request" });
    }

    const clean = field === "phone" ? value.trim() : value.toLowerCase().trim();
    const existing = await User.findOne({ [field]: clean }).select("_id");

    res.json({ available: !existing });
  } catch (error) {
    console.error("Check availability error:", error.message);
    res.status(500).json({ message: "Server error" });
  }
};

// @desc    Self-registration for customers (fullName + email OR phone + password)
// @route   POST /api/auth/register-customer
// @access  Public
export const registerCustomer = async (req, res) => {
  try {
    const { fullName, method, contact, password } = req.body;

    if (!fullName || !method || !contact || !password) {
      return res.status(400).json({ message: "All fields are required" });
    }
    if (!["email", "phone"].includes(method)) {
      return res.status(400).json({ message: "Choose email or phone" });
    }
    if (password.length < 6) {
      return res.status(400).json({ message: "Password must be at least 6 characters" });
    }

    const cleanContact = method === "email" ? contact.toLowerCase().trim() : contact.trim();

    const contactTaken = await User.findOne({ [method]: cleanContact });
    if (contactTaken) {
      return res.status(400).json({
        message: method === "email" ? "This email is already registered" : "This phone number is already registered",
      });
    }

    const hashed = await bcrypt.hash(password, 10);

    const user = await User.create({
      fullName: fullName.trim(),
      password: hashed,
      isAdmin: false,
      role: "customer",
      [method]: cleanContact,
    });

    const token = generateToken(user);
    res.cookie("token", token, getCookieOptions());

    res.status(201).json({ user: publicUser(user) });
  } catch (error) {
    console.error("Register customer error:", error.message);
    res.status(500).json({ message: "Server error" });
  }
};

// @desc    Create a new staff user — admin only
//          { fullName, method, contact, password, isAdmin, role }
//          role is one of "kitchen" | "waiter" | "accountant", ignored when isAdmin is true
// @route   POST /api/auth/register
// @access  Protected — admin
export const createUser = async (req, res) => {
  try {
    const { fullName, method, contact, password, isAdmin, role } = req.body;

    if (!fullName || !method || !contact || !password) {
      return res.status(400).json({ message: "All fields are required" });
    }
    if (!["email", "phone"].includes(method)) {
      return res.status(400).json({ message: "Choose email or phone" });
    }
    if (!isAdmin && !["kitchen", "waiter", "accountant"].includes(role)) {
      return res.status(400).json({ message: "Choose a role: kitchen, waiter, or accountant" });
    }

    const cleanContact = method === "email" ? contact.toLowerCase().trim() : contact.trim();

    const existing = await User.findOne({ [method]: cleanContact });
    if (existing) {
      return res.status(400).json({ message: "A user with that email/phone already exists" });
    }

    const hashed = await bcrypt.hash(password, 10);

    const user = await User.create({
      fullName: fullName.trim(),
      password: hashed,
      isAdmin: !!isAdmin,
      role: isAdmin ? "customer" : role, // role is ignored on the frontend when isAdmin is true
      [method]: cleanContact,
    });

    res.status(201).json({
      message: "User created successfully",
      user: publicUser(user),
    });
  } catch (error) {
    console.error("Create user error:", error.message);
    res.status(500).json({ message: "Server error" });
  }
};

// @desc    Get all active waiters
// @route   GET /api/auth/waiters
// @access  Protected
export const getWaiters = async (req, res) => {
  try {
    const waiters = await User.find({ role: "waiter", isActive: true })
      .select("fullName")
      .sort({ fullName: 1 });

    res.json(waiters.map((w) => ({ id: w._id, fullName: w.fullName })));
  } catch (error) {
    console.error("Failed to fetch waiters:", error.message);
    res.status(500).json({ message: "Failed to fetch waiters" });
  }
};

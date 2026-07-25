// controllers/authController.js
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import User from "../models/User.js";

// ======================= HELPERS =======================

const generateToken = (user) => {
  return jwt.sign(
    { id: user._id, isAdmin: user.isAdmin, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: "7d" }
  );
};

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
  permissions: user.role === "accountant" ? user.permissions : undefined,
});

// Fuller shape for the admin Users panel — includes status + join date
const adminUserView = (user) => ({
  id: user._id,
  fullName: user.fullName,
  email: user.email || null,
  phone: user.phone || null,
  isAdmin: user.isAdmin,
  role: user.role,
  isActive: user.isActive,
  createdAt: user.createdAt,
});

// ======================= LOGIN =======================
// @desc    Authenticate any user (customer, kitchen, waiter, accountant, admin)
//          by email or phone — cookie-based session, same flow as MarinePanel:
//          find -> compare password -> check account status -> sign -> cookie.
// @route   POST /api/auth/login
// @access  Public
export const login = async (req, res) => {
  try {
    let { identifier, password } = req.body;

    if (!identifier || !password) {
      return res.status(400).json({ message: "Enter your email/phone and password" });
    }

    identifier = identifier.trim();
    const value = identifier.toLowerCase();

    const user = await User.findOne({
      $or: [{ email: value }, { phone: identifier }],
    });

    if (!user) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    if (!user.isActive) {
      return res.status(403).json({
        message: "Your account has been deactivated. Contact your admin.",
      });
    }

    const token = generateToken(user);
    res.cookie("token", token, getCookieOptions());

    res.json({ user: publicUser(user) });
  } catch (error) {
    console.error("LOGIN ERROR:", error);
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

// @desc    Return the logged-in user
// @route   GET /api/auth/me
// @access  Protected
export const getMe = async (req, res) => {
  res.json({ user: publicUser(req.user) });
};

// @desc    Check if an email/phone is already taken
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
    console.error("CHECK AVAILABILITY ERROR:", error);
    res.status(500).json({ message: "Server error" });
  }
};

// ======================= REGISTER (customer self-signup) =======================
// @route   POST /api/auth/register-customer
// @access  Public
export const registerCustomer = async (req, res) => {
  try {
    let { fullName, method, contact, password } = req.body;

    if (!fullName || !method || !contact || !password) {
      return res.status(400).json({ message: "All fields are required" });
    }
    if (!["email", "phone"].includes(method)) {
      return res.status(400).json({ message: "Choose email or phone" });
    }
    if (password.length < 6) {
      return res.status(400).json({ message: "Password must be at least 6 characters" });
    }

    fullName = fullName.trim();
    const cleanContact = method === "email" ? contact.toLowerCase().trim() : contact.trim();

    const contactTaken = await User.findOne({ [method]: cleanContact });
    if (contactTaken) {
      return res.status(400).json({
        message: method === "email" ? "This email is already registered" : "This phone number is already registered",
      });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const user = await User.create({
      fullName,
      password: hashedPassword,
      isAdmin: false,
      role: "customer",
      [method]: cleanContact,
    });

    const token = generateToken(user);
    res.cookie("token", token, getCookieOptions());

    res.status(201).json({ user: publicUser(user) });
  } catch (error) {
    console.error("REGISTER CUSTOMER ERROR:", error);
    res.status(500).json({ message: "Server error" });
  }
};

// ======================= REGISTER (staff, admin-only) =======================
// @route   POST /api/auth/register
// @access  Protected — admin
export const createUser = async (req, res) => {
  try {
    let { fullName, method, contact, password, isAdmin, role } = req.body;

    if (!fullName || !method || !contact || !password) {
      return res.status(400).json({ message: "All fields are required" });
    }
    if (!["email", "phone"].includes(method)) {
      return res.status(400).json({ message: "Choose email or phone" });
    }
    if (!isAdmin && !["kitchen", "waiter", "accountant"].includes(role)) {
      return res.status(400).json({ message: "Choose a role: kitchen, waiter, or accountant" });
    }

    fullName = fullName.trim();
    const cleanContact = method === "email" ? contact.toLowerCase().trim() : contact.trim();

    const existing = await User.findOne({ [method]: cleanContact });
    if (existing) {
      return res.status(400).json({ message: "A user with that email/phone already exists" });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const isDirectWaiter = !isAdmin && role === "waiter";

    const user = await User.create({
      fullName,
      password: hashedPassword,
      isAdmin: !!isAdmin,
      role: isAdmin ? "customer" : role,
      [method]: cleanContact,
      ...(isDirectWaiter && { waiterSince: new Date(), waiterSource: "direct" }),
    });

    res.status(201).json({
      message: "User created successfully",
      user: adminUserView(user),
    });
  } catch (error) {
    console.error("CREATE USER ERROR:", error);
    res.status(500).json({ message: "Server error" });
  }
};

// @desc    Get the waiter list visible to the CURRENT logged-in user's dropdown
// @route   GET /api/auth/waiters
// @access  Protected
export const getWaiters = async (req, res) => {
  try {
    const requester = req.user; // set by `protect` middleware, already the full user doc

    const baseFilter = { role: "waiter", isActive: true, hiddenFromSelector: { $ne: true } };

    // If the requester is a waiter with a custom-restricted dropdown, narrow it down —
    // but always include the requester's own id, since a waiter must always be able
    // to select themselves regardless of what the admin picked for them.
    if (requester?.role === "waiter" && requester.selectorMode === "custom") {
      const allowedIds = [...(requester.visibleWaiters || []), requester._id];
      baseFilter._id = { $in: allowedIds };
    }

    const waiters = await User.find(baseFilter).select("fullName").sort({ fullName: 1 });

    res.json(waiters.map((w) => ({ id: w._id, fullName: w.fullName })));
  } catch (error) {
    console.error("GET WAITERS ERROR:", error);
    res.status(500).json({ message: "Failed to fetch waiters" });
  }
};

// @desc    Get every staff/admin account for the admin Users panel (customers excluded)
// @route   GET /api/auth/users
// @access  Protected — admin
export const getAllUsers = async (req, res) => {
  try {
    const users = await User.find({
      $or: [{ isAdmin: true }, { role: { $ne: "customer" } }],
    }).sort({ createdAt: -1 });

    res.json(users.map(adminUserView));
  } catch (error) {
    console.error("GET ALL USERS ERROR:", error);
    res.status(500).json({ message: "Failed to fetch users" });
  }
};

// @desc    Get EVERY user, including normal customers — used by the Users
//          panel's "All Users" view so customers can be promoted to staff.
// @route   GET /api/auth/users/all
// @access  Protected — admin
export const getAllUsersIncludingCustomers = async (req, res) => {
  try {
    const users = await User.find({}).sort({ createdAt: -1 });
    res.json(users.map(adminUserView));
  } catch (error) {
    console.error("GET ALL USERS (INCL CUSTOMERS) ERROR:", error);
    res.status(500).json({ message: "Failed to fetch users" });
  }
};

// @desc    Count of staff/admin accounts (customers excluded) — Dashboard metric
// @route   GET /api/auth/staff-count
// @access  Protected — admin
export const getStaffCount = async (req, res) => {
  try {
    const totalStaff = await User.countDocuments({
      $or: [{ isAdmin: true }, { role: { $ne: "customer" } }],
    });
    res.json({ totalStaff });
  } catch (error) {
    console.error("GET STAFF COUNT ERROR:", error);
    res.status(500).json({ message: "Failed to fetch staff count" });
  }
};

// @desc    Promote/change a user's role — works for staff AND customers,
//          so a normal customer account can be promoted to staff/admin.
//          Body: { isAdmin: true } -> full admin
//          Body: { role: "kitchen" | "waiter" | "accountant" } -> staff role, isAdmin false
// @route   PATCH /api/auth/users/:id/role
// @access  Protected — admin
export const updateUserRole = async (req, res) => {
  try {
    const { id } = req.params;
    const { isAdmin, role } = req.body;

    if (req.user._id.toString() === id) {
      return res.status(400).json({ message: "You can't change your own role" });
    }

    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    if (isAdmin) {
      user.isAdmin = true;
    } else {
      if (!["kitchen", "waiter", "accountant"].includes(role)) {
        return res.status(400).json({ message: "Choose a role: kitchen, waiter, or accountant" });
      }
      const becomingWaiter = role === "waiter" && user.role !== "waiter";
      user.isAdmin = false;
      user.role = role;
      if (becomingWaiter) {
        user.waiterSince = new Date();
        user.waiterSource = "promoted";
      }
    }

    await user.save();
    res.json({ message: "Role updated successfully", user: adminUserView(user) });
  } catch (error) {
    console.error("UPDATE USER ROLE ERROR:", error);
    res.status(500).json({ message: "Failed to update role" });
  }
};

// @desc    Activate or deactivate any account
// @route   PATCH /api/auth/users/:id/status
// @access  Protected — admin
export const toggleUserStatus = async (req, res) => {
  try {
    const { id } = req.params;

    if (req.user._id.toString() === id) {
      return res.status(400).json({ message: "You can't deactivate your own account" });
    }

    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    user.isActive = !user.isActive;
    await user.save();

    res.json({ message: "Status updated", user: adminUserView(user) });
  } catch (error) {
    console.error("TOGGLE USER STATUS ERROR:", error);
    res.status(500).json({ message: "Failed to update status" });
  }
};

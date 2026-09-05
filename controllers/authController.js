// controllers/authController.js
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import User from "../models/User.js";
import crypto from "crypto";
import sendResetEmail from "../utils/sendResetEmail.js";
import { sendResetCode } from "../utils/sendResetSms.js";
import { validatePassword } from "../utils/validatePassword.js";
// ======================= HELPERS =======================

const generateToken = (user) => {
  return jwt.sign(
    { id: user._id, businessId: user.businessId, isAdmin: user.isAdmin, role: user.role },
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
    path: "/",
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
      _bypassTenantGuard: true,
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
// @desc    Check if an email/phone is already taken (within one business)
// @route   GET /api/auth/check-availability?field=email&value=jane@mail.com&businessId=<id>
// @access  Public
export const checkAvailability = async (req, res) => {
  try {
    const { field, value, businessId } = req.query;

    if (!field || !value || !["email", "phone"].includes(field)) {
      return res.status(400).json({ message: "Invalid check request" });
    }

    if (!businessId) {
      return res.status(400).json({ message: "Missing business — scan the table QR code again" });
    }

    const clean = field === "phone" ? value.trim() : value.toLowerCase().trim();
    const existing = await User.findOne({ [field]: clean, businessId }).select("_id");

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
let { fullName, method, contact, password, businessId } = req.body;

if (!businessId) {
  return res.status(400).json({ message: "Missing business — scan the table QR code again" });
}
    if (!fullName || !method || !contact || !password) {
      return res.status(400).json({ message: "All fields are required" });
    }

    if (!["email", "phone"].includes(method)) {
      return res.status(400).json({ message: "Choose email or phone" });
    }

       const passwordCheck = validatePassword(password);
    if (!passwordCheck.valid) {
      return res.status(400).json({ message: "Password does not meet the requirements", requirements: passwordCheck.errors });
    }

    fullName = fullName.trim();
    const cleanContact = method === "email" ? contact.toLowerCase().trim() : contact.trim();

const contactTaken = await User.findOne({ [method]: cleanContact, businessId });    if (contactTaken) {
      return res.status(400).json({
        message:
          method === "email"
            ? "This email is already registered"
            : "This phone number is already registered",
      });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const user = await User.create({
  fullName,
  password: hashedPassword,
  isAdmin: false,
  role: "customer",
  businessId,
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
    const passwordCheck = validatePassword(password);
    if (!passwordCheck.valid) {
      return res.status(400).json({ message: "Password does not meet the requirements", requirements: passwordCheck.errors });
    }

    fullName = fullName.trim();
    const cleanContact =
      method === "email" ? contact.toLowerCase().trim() : contact.trim();

    const existing = await User.findOne({ [method]: cleanContact, businessId: req.businessId });
    if (existing) {
      return res.status(400).json({
        message: "A user with that email/phone already exists",
      });
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
  businessId: req.businessId,
  ...(isDirectWaiter && {
    waiterSince: new Date(),
    waiterSource: "direct",
  }),
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
    const requester = req.user;
    const { businessId } = req;

    const baseFilter = {
      businessId,
      role: "waiter",
      isActive: true,
      hiddenFromSelector: { $ne: true },
    };

    if (
      requester?.role === "waiter" &&
      requester.selectorMode === "custom"
    ) {
      const allowedIds = [...(requester.visibleWaiters || []), requester._id];
      baseFilter._id = { $in: allowedIds };
    }

    const waiters = await User.find(baseFilter)
      .select("fullName")
      .sort({ fullName: 1 });

    res.json(
      waiters.map((w) => ({
        id: w._id,
        fullName: w.fullName,
      }))
    );
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
      businessId: req.businessId,
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
    const users = await User.find({ businessId: req.businessId }).sort({ createdAt: -1 });
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
      businessId: req.businessId,
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
    const { businessId } = req;

    if (req.user._id.toString() === id) {
      return res.status(400).json({ message: "You can't change your own role" });
    }

    const user = await User.findOne({ _id: id, businessId });
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    if (isAdmin) {
      user.isAdmin = true;
    } else {
      if (!["kitchen", "waiter", "accountant"].includes(role)) {
        return res.status(400).json({
          message: "Choose a role: kitchen, waiter, or accountant",
        });
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

    res.json({
      message: "Role updated successfully",
      user: adminUserView(user),
    });
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
    const { businessId } = req;

    if (req.user._id.toString() === id) {
      return res.status(400).json({
        message: "You can't deactivate your own account",
      });
    }

    const user = await User.findOne({ _id: id, businessId });
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    user.isActive = !user.isActive;
    await user.save();

    res.json({
      message: "Status updated",
      user: adminUserView(user),
    });
  } catch (error) {
    console.error("TOGGLE USER STATUS ERROR:", error);
    res.status(500).json({ message: "Failed to update status" });
  }
};

// @desc    Update the logged-in user's own contact info (email/phone/name).
//          Used by Profile > Personal Details — lets a user add whichever
//          of email/phone they're missing (or edit the one they have).
// @route   PATCH /api/auth/me
// @access  Protected
export const updateMe = async (req, res) => {
  try {
    let { fullName, email, phone } = req.body;
    const { businessId } = req;
    const user = await User.findOne({ _id: req.user._id, businessId });

    if (fullName !== undefined) {
      fullName = fullName.trim();

      if (!fullName) {
        return res.status(400).json({
          message: "Full name can't be empty",
        });
      }

      user.fullName = fullName;
    }

    if (email !== undefined && email !== null && email !== "") {
      const cleanEmail = email.toLowerCase().trim();

      if (cleanEmail !== (user.email || "")) {
        const taken = await User.findOne({
          email: cleanEmail,
          businessId,
          _id: { $ne: user._id },
        });

        if (taken) {
          return res.status(400).json({
            message: "This email is already registered",
          });
        }

        user.email = cleanEmail;
      }
    }

    if (phone !== undefined && phone !== null && phone !== "") {
      const cleanPhone = phone.trim();

      if (cleanPhone !== (user.phone || "")) {
        const taken = await User.findOne({
          phone: cleanPhone,
          businessId,
          _id: { $ne: user._id },
        });

        if (taken) {
          return res.status(400).json({
            message: "This phone number is already registered",
          });
        }

        user.phone = cleanPhone;
      }
    }

    if (!user.email && !user.phone) {
      return res.status(400).json({
        message: "You must have at least one of email or phone",
      });
    }

    await user.save();
    res.json({ user: publicUser(user) });
  } catch (error) {
    console.error("UPDATE ME ERROR:", error);
    res.status(500).json({ message: "Server error" });
  }
};

// @desc    Change the logged-in user's own password
// @route   PUT /api/auth/change-password
// @access  Protected
export const changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword, confirmPassword } = req.body;

    if (!currentPassword || !newPassword || !confirmPassword) {
      return res.status(400).json({ message: "All fields are required" });
    }

    if (newPassword !== confirmPassword) {
      return res.status(400).json({ message: "New passwords don't match" });
    }

        const passwordCheck = validatePassword(newPassword);
    if (!passwordCheck.valid) {
      return res.status(400).json({ message: "Password does not meet the requirements", requirements: passwordCheck.errors });
    }

    const user = await User.findOne({ _id: req.user._id, businessId: req.businessId }); // req.user has password excluded, refetch full doc
    const isMatch = await bcrypt.compare(currentPassword, user.password);

    if (!isMatch) {
      return res.status(401).json({
        message: "Current password is incorrect",
      });
    }

    const salt = await bcrypt.genSalt(10);
    user.password = await bcrypt.hash(newPassword, salt);
    await user.save();

    res.json({ message: "Password updated successfully" });
  } catch (error) {
    console.error("CHANGE PASSWORD ERROR:", error);
    res.status(500).json({ message: "Server error" });
  }
};

// ======================= FORGOT PASSWORD HELPERS =======================
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

const hashCode = (code) =>
  crypto.createHash("sha256").update(code).digest("hex");

const generateNumericCode = () =>
  Math.floor(100000 + Math.random() * 900000).toString();

const maskContact = (value, method) => {
  if (method === "email") {
    const [name, domain] = value.split("@");
    return `${name.slice(0, 2)}${"*".repeat(
      Math.max(name.length - 2, 1)
    )}@${domain}`;
  }

  return value.slice(0, -4).replace(/./g, "*") + value.slice(-4);
};

const RESEND_COOLDOWN_MS = 60 * 1000;
const CODE_EXPIRY_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;

// ======================= FORGOT PASSWORD (step 1: request code) =======================
// @route   POST /api/auth/forgot-password
// @body    { identifier }  -- email OR phone
// @access  Public
export const forgotPassword = async (req, res) => {
  try {
    const { identifier } = req.body;

    if (!identifier || !identifier.trim()) {
      return res.status(400).json({
        message: "Enter your email or phone number",
      });
    }

    const value = identifier.trim();
    const method = isEmail(value) ? "email" : "phone";
    const clean = method === "email" ? value.toLowerCase() : value;

    const user = await User.findOne({ [method]: clean, _bypassTenantGuard: true }).select(
      "+resetCode +resetCodeExpires +resetCodeAttempts +resetCodeChannel +resetCodeLastSentAt"
    );

    if (!user) {
      return res.status(404).json({
        notFound: true,
        message: "No account found with that email or phone number.",
      });
    }

    if (
      user.resetCodeLastSentAt &&
      Date.now() - user.resetCodeLastSentAt.getTime() < RESEND_COOLDOWN_MS
    ) {
      const waitSec = Math.ceil(
        (RESEND_COOLDOWN_MS -
          (Date.now() - user.resetCodeLastSentAt.getTime())) /
          1000
      );

      return res.status(429).json({
        message: `Please wait ${waitSec}s before requesting another code.`,
      });
    }

    const code = generateNumericCode();
    const channel = method === "email" ? "email" : "sms";

    user.resetCode = hashCode(code);
    user.resetCodeExpires = new Date(Date.now() + CODE_EXPIRY_MS);
    user.resetCodeAttempts = 0;
    user.resetCodeChannel = channel;
    user.resetCodeLastSentAt = new Date();

    await user.save();

    try {
      if (method === "email") {
        await sendResetEmail({
          to: user.email,
          code,
          fullName: user.fullName,
        });
      } else {
        await sendResetCode({
          to: user.phone,
          code,
          channel: "sms",
        });
      }
    } catch (sendErr) {
      console.error("SEND RESET CODE ERROR:", sendErr);

      return res.status(500).json({
        message: "Failed to send reset code. Please try again.",
      });
    }

    res.json({
      message: `A reset code was sent via ${channel}.`,
      method,
      channel,
      maskedContact: maskContact(clean, method),
    });
  } catch (error) {
    console.error("FORGOT PASSWORD ERROR:", error);
    res.status(500).json({ message: "Server error" });
  }
};

// ======================= RESEND CODE (SMS <-> WhatsApp switch) =======================
// @route   POST /api/auth/resend-reset-code
// @body    { identifier, channel }  -- channel: "sms" | "whatsapp" (phone only)
// @access  Public
export const resendResetCode = async (req, res) => {
  try {
    const { identifier, channel } = req.body;

    if (!identifier) {
      return res.status(400).json({ message: "Missing identifier" });
    }

    const value = identifier.trim();
    const method = isEmail(value) ? "email" : "phone";
    const clean = method === "email" ? value.toLowerCase() : value;

    const user = await User.findOne({ [method]: clean, _bypassTenantGuard: true }).select(
      "+resetCode +resetCodeExpires +resetCodeAttempts +resetCodeChannel +resetCodeLastSentAt"
    );

    if (!user) {
      return res.status(404).json({
        notFound: true,
        message: "Account not found",
      });
    }

    if (
      user.resetCodeLastSentAt &&
      Date.now() - user.resetCodeLastSentAt.getTime() < RESEND_COOLDOWN_MS
    ) {
      const waitSec = Math.ceil(
        (RESEND_COOLDOWN_MS -
          (Date.now() - user.resetCodeLastSentAt.getTime())) /
          1000
      );

      return res.status(429).json({
        message: `Please wait ${waitSec}s before resending.`,
      });
    }

    const code = generateNumericCode();

    const useChannel =
      method === "phone" && channel === "whatsapp"
        ? "whatsapp"
        : method === "email"
          ? "email"
          : "sms";

    user.resetCode = hashCode(code);
    user.resetCodeExpires = new Date(Date.now() + CODE_EXPIRY_MS);
    user.resetCodeAttempts = 0;
    user.resetCodeChannel = useChannel;
    user.resetCodeLastSentAt = new Date();

    await user.save();

    if (method === "email") {
      await sendResetEmail({
        to: user.email,
        code,
        fullName: user.fullName,
      });
    } else {
      await sendResetCode({
        to: user.phone,
        code,
        channel: useChannel,
      });
    }

    res.json({
      message: `Code resent via ${useChannel}.`,
      channel: useChannel,
    });
  } catch (error) {
    console.error("RESEND RESET CODE ERROR:", error);
    res.status(500).json({ message: "Server error" });
  }
};

// ======================= VERIFY CODE (step 2) =======================
// @route   POST /api/auth/verify-reset-code
// @body    { identifier, code }
// @access  Public
export const verifyResetCode = async (req, res) => {
  try {
    const { identifier, code } = req.body;

    if (!identifier || !code) {
      return res.status(400).json({
        message: "Identifier and code are required",
      });
    }

    const value = identifier.trim();
    const method = isEmail(value) ? "email" : "phone";
    const clean = method === "email" ? value.toLowerCase() : value;

    const user = await User.findOne({ [method]: clean, _bypassTenantGuard: true }).select(
      "+resetCode +resetCodeExpires +resetCodeAttempts"
    );

    if (!user || !user.resetCode) {
      return res.status(400).json({
        message: "Invalid or expired code",
      });
    }

    if (user.resetCodeExpires < new Date()) {
      return res.status(400).json({
        message: "Code expired. Please request a new one.",
      });
    }

    if (user.resetCodeAttempts >= MAX_ATTEMPTS) {
      return res.status(429).json({
        message: "Too many attempts. Please request a new code.",
      });
    }

    if (hashCode(code.trim()) !== user.resetCode) {
      user.resetCodeAttempts += 1;
      await user.save();

      return res.status(400).json({
        message: "Incorrect code",
      });
    }

    const resetToken = crypto.randomBytes(32).toString("hex");

    user.resetToken = hashCode(resetToken);
    user.resetTokenExpires = new Date(Date.now() + 10 * 60 * 1000);
    user.resetCode = undefined;
    user.resetCodeExpires = undefined;
    user.resetCodeAttempts = 0;

    await user.save();

    res.json({
      message: "Code verified",
      resetToken,
    });
  } catch (error) {
    console.error("VERIFY RESET CODE ERROR:", error);
    res.status(500).json({ message: "Server error" });
  }
};

// ======================= RESET PASSWORD (step 3) =======================
// @route   POST /api/auth/reset-password
// @body    { resetToken, newPassword }
// @access  Public
export const resetPasswordWithCode = async (req, res) => {
  try {
    const { resetToken, newPassword } = req.body;

    if (!resetToken || !newPassword) {
      return res.status(400).json({
        message: "Missing reset token or new password",
      });
    }

        const passwordCheck = validatePassword(newPassword);
    if (!passwordCheck.valid) {
      return res.status(400).json({ message: "Password does not meet the requirements", requirements: passwordCheck.errors });
    }

    const user = await User.findOne({
      resetToken: hashCode(resetToken),
      resetTokenExpires: { $gt: new Date() },
      _bypassTenantGuard: true,
    }).select("+resetToken +resetTokenExpires");

    if (!user) {
      return res.status(400).json({
        message: "Invalid or expired session. Please start over.",
      });
    }

    const salt = await bcrypt.genSalt(10);
    user.password = await bcrypt.hash(newPassword, salt);
    user.resetToken = undefined;
    user.resetTokenExpires = undefined;

    await user.save();

    res.json({ message: "Password reset successful" });
  } catch (error) {
    console.error("RESET PASSWORD ERROR:", error);
    res.status(500).json({ message: "Server error" });
  }
};
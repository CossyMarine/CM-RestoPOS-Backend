// middlewares/authMiddleware.js
import jwt from "jsonwebtoken";
import User from "../models/User.js";
import Shift from "../models/Shift.js";

// Protect routes — reads the httpOnly cookie set on login
export const protect = async (req, res, next) => {
  const token = req.cookies?.token;

  if (!token) {
    return res.status(401).json({ message: "Not authorized, no token" });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET, {
  algorithms: ["HS256"],
});

const user = await User.findById(decoded.id).select("-password");

if (!user) {
  return res.status(401).json({ message: "Not authorized, user not found" });
}

if (!user.isActive) {
  return res
    .status(403)
    .json({ message: "Your account has been deactivated. Contact your admin." });
}

req.user = user;
req.businessId = user.businessId;
next();
  } catch (error) {
    console.error("Auth middleware error:", error.message);
    return res.status(401).json({ message: "Not authorized, token failed" });
  }
};

// Restrict a route to specific roles.
// Pass "admin" to require isAdmin === true; pass "kitchen"/"waiter"/"accountant"
// to require that exact `role`. e.g. authorize("admin", "waiter")
export const authorize = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(403).json({ message: "Insufficient permissions" });
    }
    if (allowedRoles.includes("admin") && req.user.isAdmin) {
      return next();
    }
    if (allowedRoles.includes(req.user.role)) {
      return next();
    }
    return res.status(403).json({ message: "Insufficient permissions" });
  };
};

// Gate a route behind one of an accountant's toggleable permissions.
// Admins always pass — permissions only apply to role: "accountant".
export const requirePermission = (key) => (req, res, next) => {
  if (!req.user) return res.status(403).json({ message: "Insufficient permissions" });
  if (req.user.isAdmin) return next();
  if (req.user.role !== "accountant") return next(); // only accountants are permission-gated
  if (req.user.permissions?.[key]) return next();
  return res.status(403).json({ message: "You don't have access to this section" });
};

// Blocks payment-processing routes unless the accountant has an open shift.
// Admins bypass this — they aren't shift-gated.
export const requireOpenShift = async (req, res, next) => {
  if (req.user?.isAdmin) return next();
  try {
    const shift = await Shift.findOne({ openedBy: req.user._id, status: "open" });
    if (!shift) {
      return res.status(403).json({ message: "Open your shift before processing payments." });
    }
    req.shift = shift; // handy for controllers to stamp receipt.shift
    next();
  } catch (error) {
    res.status(500).json({ message: "Failed to verify shift status", error: error.message });
  }
};
// Blocks a waiter-identified action unless that specific named waiter has
// an open shift — checks the ACTING waiter (from the request body), not
// req.user, since waiter stations are a shared login where req.user is the
// station account, not the individual waiter performing the action.
export const requireOpenShiftForWaiter = (field = "waiterName") => async (req, res, next) => {
  if (req.user?.isAdmin) return next();

  const waiterName = req.body[field];
  if (!waiterName) {
    return res.status(400).json({ message: `${field} is required` });
  }

  try {
    const waiterUser = await User.findOne({ fullName: waiterName, role: "waiter" }).select("_id");
    if (!waiterUser) {
      return res.status(404).json({ message: `No waiter found named "${waiterName}"` });
    }
    const openShift = await Shift.findOne({ openedBy: waiterUser._id, status: "open" });
    if (!openShift) {
      return res.status(403).json({
        message: `${waiterName}'s shift is closed — open their shift before doing this.`,
      });
    }
    next();
  } catch (error) {
    res.status(500).json({ message: "Failed to verify shift status", error: error.message });
  }
};
// Platform-level only — Business A/B/C admins never pass this.
export const requireSuperAdmin = (req, res, next) => {
  if (!req.user || req.user.role !== "superadmin") {
    return res.status(403).json({ message: "Superadmin access only" });
  }
  next();
};

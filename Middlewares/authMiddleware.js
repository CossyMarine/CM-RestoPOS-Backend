// middlewares/authMiddleware.js
import jwt from "jsonwebtoken";
import User from "../models/User.js";

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

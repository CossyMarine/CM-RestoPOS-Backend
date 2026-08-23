
import express from "express";
import rateLimit from "express-rate-limit";

import {
    login,
    logout,
    getMe,
    createUser,
    getWaiters,
    registerCustomer,
    checkAvailability,
    getAllUsers,
    getAllUsersIncludingCustomers,
    getStaffCount,
    updateUserRole,
    toggleUserStatus,
    updateMe,
    changePassword,
    forgotPassword,
    resendResetCode,
    verifyResetCode,
    resetPasswordWithCode,
} from "../controllers/authController.js";

import {
    protect,
    authorize,
    requirePermission,
} from "../Middlewares/authMiddleware.js";

const router = express.Router();

const resetLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 8,
    message: { message: "Too many requests. Please try again later." },
});

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 15,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        message:
            "Too many attempts — please wait 15 minutes and try again.",
    },
});

router.post("/login", loginLimiter, login);

router.post("/logout", logout);

router.get("/me", protect, getMe);

router.patch("/me", protect, updateMe);

router.put("/change-password", protect, changePassword);

router.get("/check-availability", checkAvailability);

router.post("/register-customer", loginLimiter, registerCustomer);

router.post(
    "/register",
    loginLimiter,
    protect,
    authorize("admin"),
    createUser
);

router.get("/waiters", protect, getWaiters);

// Forgot password (numeric code flow — email via Resend, phone via OpenSMS SMS/WhatsApp)

router.post("/forgot-password", resetLimiter, forgotPassword);

router.post("/resend-reset-code", resetLimiter, resendResetCode);

router.post("/verify-reset-code", resetLimiter, verifyResetCode);

router.post("/reset-password", resetLimiter, resetPasswordWithCode);

// Admin — Users management panel

router.get(
    "/users",
    protect,
    authorize("admin", "accountant"),
    requirePermission("users"),
    getAllUsers
);

router.get(
    "/users/all",
    protect,
    authorize("admin", "accountant"),
    requirePermission("users"),
    getAllUsersIncludingCustomers
);

router.get(
    "/staff-count",
    protect,
    authorize("admin", "accountant"),
    requirePermission("users"),
    getStaffCount
);

router.patch(
    "/users/:id/role",
    protect,
    authorize("admin", "accountant"),
    requirePermission("users"),
    updateUserRole
);

router.patch(
    "/users/:id/status",
    protect,
    authorize("admin", "accountant"),
    requirePermission("users"),
    toggleUserStatus
);

export default router;


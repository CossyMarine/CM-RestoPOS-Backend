// routes/authRoutes.js
import express from "express";
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
} from "../controllers/authController.js";
import { protect, authorize } from "../Middlewares/authMiddleware.js";

const router = express.Router();

router.post("/login", login);
router.post("/logout", logout);
router.get("/me", protect, getMe);
router.get("/check-availability", checkAvailability);
router.post("/register-customer", registerCustomer);
router.post("/register", protect, authorize("admin"), createUser);
router.get("/waiters", protect, getWaiters);

// Admin — Users management panel
router.get("/users", protect, authorize("admin"), getAllUsers);
router.get("/users/all", protect, authorize("admin"), getAllUsersIncludingCustomers);
router.get("/staff-count", protect, authorize("admin"), getStaffCount);
router.patch("/users/:id/role", protect, authorize("admin"), updateUserRole);
router.patch("/users/:id/status", protect, authorize("admin"), toggleUserStatus);

export default router;

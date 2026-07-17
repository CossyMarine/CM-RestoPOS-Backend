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
} from "../controllers/authController.js";
import { protect, authorize } from "../Middlewares/authMiddleware.js";

const router = express.Router();

router.post("/login", login);
router.post("/logout", logout);
router.get("/me", protect, getMe); // frontend calls this on load to identify the session
router.get("/check-availability", checkAvailability); // public — live signup validation
router.post("/register-customer", registerCustomer); // public — customer self-signup
router.post("/register", protect, authorize("admin"), createUser); // staff only
router.get("/waiters", protect, getWaiters);

export default router;

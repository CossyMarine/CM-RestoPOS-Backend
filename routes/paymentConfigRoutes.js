// routes/paymentConfigRoutes.js
import express from "express";
import { protect, authorize } from "../Middlewares/authMiddleware.js";
import { getPaymentConfig, setPaymentConfig } from "../controllers/paymentConfigController.js";

const router = express.Router();

router.use(protect, authorize("admin")); // admin-only — never expose to waiter/kitchen/accountant

router.get("/:provider", getPaymentConfig);
router.put("/:provider", setPaymentConfig);

export default router;
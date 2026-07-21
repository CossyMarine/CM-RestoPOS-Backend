// routes/paymentRoutes.js
import express from "express";
import {
  getTransactions,
  getPendingManualPayments,
  getPendingManualPaymentsCount,
  confirmManualPayment,
  rejectManualPayment,
} from "../controllers/paymentController.js";
import { protect, authorize } from "../Middlewares/authMiddleware.js";

const router = express.Router();

router.get("/transactions", protect, authorize("admin", "accountant"), getTransactions);
router.get("/pending", protect, authorize("admin", "accountant"), getPendingManualPayments);
router.get("/pending/count", protect, authorize("admin", "accountant"), getPendingManualPaymentsCount);

router.patch("/pending/:receiptId/:paymentId/confirm", protect, authorize("admin"), confirmManualPayment);
router.patch("/pending/:receiptId/:paymentId/reject", protect, authorize("admin"), rejectManualPayment);

export default router;

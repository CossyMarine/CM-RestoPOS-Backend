// routes/receiptRoutes.js
import express from "express";
import {
  payReceipt,
  getReceipts,
  getPaidReceipts,
  getReceiptsByWaiter,
  getReceiptById,
  getReceiptHistoryByWaiter,
  addItemsToReceipt,
  markReceiptPrinted,
} from "../controllers/receiptController.js";
import { protect, authorize } from "../Middlewares/authMiddleware.js";

const router = express.Router();

router.patch("/:id/pay", protect, authorize("admin"), payReceipt);
router.patch(
  "/:id/items",
  protect,
  authorize("waiter", "admin", "manager", "cashier"),
  addItemsToReceipt
);
router.patch("/:id/print", protect, markReceiptPrinted);

router.get("/", protect, authorize("admin"), getReceipts);
router.get("/paid", protect, authorize("admin", "accountant"), getPaidReceipts);
router.get("/waiter/:name/history", protect, getReceiptHistoryByWaiter);
router.get("/waiter/:name", protect, getReceiptsByWaiter);

// Keep this LAST — it's a single dynamic segment and would otherwise
// swallow "/paid" and "/waiter/..." above it.
router.get("/:id", protect, getReceiptById);

export default router;

// routes/receiptRoutes.js
import express from "express";
import {
  payReceipt,
  payCashAndTill,
  initiateMpesaPayment,
  mpesaCallback,
  getMpesaStatus,
  cancelMpesaPayment,
  getReceipts,
  getPaidReceipts,
  getReceiptsTodaySummary,
  getReceiptsByWaiter,
  getReceiptById,
  getReceiptHistory,
  getReceiptHistoryByWaiter,
  addItemsToReceipt,
  markReceiptPrinted,
} from "../controllers/receiptController.js";
import { protect, authorize } from "../Middlewares/authMiddleware.js";

const router = express.Router();

// Payment
router.patch("/:id/pay", protect, authorize("admin"), payReceipt);
router.patch("/:id/pay/cash-till", protect, authorize("admin"), payCashAndTill);
router.post("/:id/mpesa/initiate", protect, authorize("admin"), initiateMpesaPayment);
router.get("/:id/mpesa/status", protect, authorize("admin"), getMpesaStatus);
router.post("/:id/mpesa/cancel", protect, authorize("admin"), cancelMpesaPayment);

// Public Safaricom webhook — no auth, Daraja calls this directly
router.post("/mpesa/callback", mpesaCallback);

router.patch(
  "/:id/items",
  protect,
  authorize("waiter", "admin", "manager", "cashier"),
  addItemsToReceipt
);
router.patch("/:id/print", protect, markReceiptPrinted);

router.get("/", protect, authorize("admin"), getReceipts);
router.get("/paid", protect, authorize("admin", "accountant"), getPaidReceipts);
router.get("/summary/today", protect, authorize("admin", "accountant"), getReceiptsTodaySummary);

// All-waiters bill history (Bill Records default view) — must come before "/:id"
router.get("/history", protect, getReceiptHistory);

router.get("/waiter/:name/history", protect, getReceiptHistoryByWaiter);
router.get("/waiter/:name", protect, getReceiptsByWaiter);

// Keep this LAST — it's a single dynamic segment and would otherwise
// swallow "/paid", "/history", "/summary/*" and "/waiter/..." above it.
router.get("/:id", protect, getReceiptById);

export default router;

// routes/receiptRoutes.js
import express from "express";
import {
  payReceipt,
  payCashAndTill,
  payCombo,
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
  getPendingOnlineReceipts,
} from "../controllers/receiptController.js";
import { protect, authorize, requirePermission, requireOpenShift } from "../Middlewares/authMiddleware.js";

const router = express.Router();

// Payment — admin OR accountant-with-payments-permission-and-open-shift
router.patch("/:id/pay", protect, authorize("admin", "accountant"), requirePermission("payments"), requireOpenShift, payReceipt);
router.patch("/:id/pay/cash-till", protect, authorize("admin", "accountant"), requirePermission("payments"), requireOpenShift, payCashAndTill);
router.patch("/:id/pay/combo", protect, authorize("admin", "accountant"), requirePermission("payments"), requireOpenShift, payCombo);
router.post("/:id/mpesa/initiate", protect, authorize("admin", "accountant"), requirePermission("payments"), requireOpenShift, initiateMpesaPayment);
router.get("/:id/mpesa/status", protect, authorize("admin", "accountant"), getMpesaStatus);
router.post("/:id/mpesa/cancel", protect, authorize("admin", "accountant"), cancelMpesaPayment);

// Public Safaricom webhook — no auth
router.post("/mpesa/callback", mpesaCallback);

router.patch("/:id/items", protect, authorize("waiter", "admin", "manager", "cashier"), addItemsToReceipt);
router.patch("/:id/print", protect, markReceiptPrinted);

router.get("/", protect, authorize("admin", "accountant"), requirePermission("ordersReceipts"), getReceipts);
router.get("/paid", protect, authorize("admin", "accountant"), getPaidReceipts);
router.get("/summary/today", protect, authorize("admin", "accountant"), getReceiptsTodaySummary);

router.get("/history", protect, getReceiptHistory);
router.get("/waiter/:name/history", protect, getReceiptHistoryByWaiter);
router.get("/waiter/:name", protect, getReceiptsByWaiter);

router.get("/online-pending", protect, authorize("admin"), getPendingOnlineReceipts);

router.get("/:id", protect, getReceiptById);

export default router;

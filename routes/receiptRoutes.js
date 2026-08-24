// routes/receiptRoutes.js

import express from "express";
import rateLimit from "express-rate-limit";

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
    applyDiscount,
} from "../controllers/receiptController.js";

import {
    protect,
    authorize,
    requirePermission,
    requireOpenShift,
} from "../Middlewares/authMiddleware.js";

const router = express.Router();

const mpesaLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    max: 8,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        message:
            "Too many payment attempts — please wait a few minutes.",
    },
});

// Payment — admin OR accountant-with-payments-permission-and-open-shift

router.patch(
    "/:id/pay",
    protect,
    authorize("admin", "accountant"),
    requirePermission("payments"),
    requireOpenShift,
    payReceipt
);

router.patch(
    "/:id/pay/cash-till",
    protect,
    authorize("admin", "accountant"),
    requirePermission("payments"),
    requireOpenShift,
    payCashAndTill
);

router.patch(
    "/:id/pay/combo",
    protect,
    authorize("admin", "accountant"),
    requirePermission("payments"),
    requireOpenShift,
    payCombo
);

router.post(
    "/:id/mpesa/initiate",
    protect,
    authorize("admin", "accountant"),
    requirePermission("payments"),
    requireOpenShift,
    mpesaLimiter,
    initiateMpesaPayment
);

// FIXED — was missing requirePermission("payments"); every sibling payment
// route requires it, this one didn't, so an accountant without payments
// access could still check an in-flight M-Pesa transaction's status.
router.get(
    "/:id/mpesa/status",
    protect,
    authorize("admin", "accountant"),
    requirePermission("payments"),
    getMpesaStatus
);

// FIXED — same gap as above, but for cancelling a live payment, which is
// the more consequential of the two to have left unguarded.
router.post(
    "/:id/mpesa/cancel",
    protect,
    authorize("admin", "accountant"),
    requirePermission("payments"),
    cancelMpesaPayment
);

router.patch(
    "/:id/discount",
    protect,
    authorize("admin", "accountant"),
    requirePermission("applyDiscounts"),
    applyDiscount
);

// Public Safaricom webhook — no auth (Safaricom's servers call this directly)

router.post("/mpesa/callback", mpesaCallback);

// FIXED — was authorize("waiter", "admin", "manager", "cashier"). "manager"
// and "cashier" aren't real roles anywhere in this system (User.role is
// only kitchen/waiter/accountant/customer, admin is a separate isAdmin
// flag) — dead, unreachable code. Replaced with the actual staff roles
// that legitimately need to add items to a bill.
router.patch(
    "/:id/items",
    protect,
    authorize("admin", "accountant", "waiter", "kitchen"),
    addItemsToReceipt
);

// FIXED — was protect only, no role check at all. A self-registered
// customer account could mark any receipt as printed. Restricted to staff.
router.patch(
    "/:id/print",
    protect,
    authorize("admin", "accountant", "waiter", "kitchen"),
    markReceiptPrinted
);

router.get(
    "/",
    protect,
    authorize("admin", "accountant"),
    requirePermission("ordersReceipts"),
    getReceipts
);

router.get(
    "/paid",
    protect,
    authorize("admin", "accountant"),
    getPaidReceipts
);

router.get(
    "/summary/today",
    protect,
    authorize("admin", "accountant"),
    getReceiptsTodaySummary
);

// FIXED — was protect only. This is the entire restaurant's paginated bill
// history across every waiter and table — any logged-in customer account
// could previously read all of it directly via the API. Now matches the
// same admin/accountant + ordersReceipts gate as the main list endpoint.
router.get(
    "/history",
    protect,
    authorize("admin", "accountant"),
    requirePermission("ordersReceipts"),
    getReceiptHistory
);

// FIXED — was protect only, no role check, and no check that :name matches
// the requester's own identity. A waiter could view ANY other waiter's
// full bill history by editing the URL, and a customer account could view
// any waiter's history at all. Route-level authorize below stops
// non-staff and stops kitchen/customer entirely; restricting a waiter to
// only their OWN name still needs a check inside the controller itself
// (the route can't see whose name is whose) — flagging that as the
// necessary follow-up, see note below.
router.get(
    "/waiter/:name/history",
    protect,
    authorize("admin", "accountant", "waiter"),
    getReceiptHistoryByWaiter
);

router.get(
    "/waiter/:name",
    protect,
    authorize("admin", "accountant", "waiter"),
    getReceiptsByWaiter
);

router.get(
    "/online-pending",
    protect,
    authorize("admin"),
    getPendingOnlineReceipts
);

// FIXED — was protect only, no role check. Any logged-in customer account
// could fetch any receipt's full financial details by ID. Restricted to
// staff who legitimately need it (printing, refreshing after adding items).
router.get(
    "/:id",
    protect,
    authorize("admin", "accountant", "waiter", "kitchen"),
    getReceiptById
);

export default router;
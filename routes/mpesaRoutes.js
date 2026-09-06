// routes/mpesaRoutes.js
import express from "express";
import { protect, authorize, requireOpenShift } from "../Middlewares/authMiddleware.js";
import { stkPush, stkCallback } from "../controllers/mpesaController.js";

const router = express.Router();

// Protected — initiating a charge requires a logged-in staff session.
// Reuses requireOpenShift since this is payment processing, same guard
// your existing paymentRoutes presumably already applies.
router.post("/stk-push", protect, authorize("admin", "accountant", "waiter"), requireOpenShift, stkPush);

// PUBLIC — Safaricom hits this directly. No `protect` here on purpose.
router.post("/callback", stkCallback);

export default router;
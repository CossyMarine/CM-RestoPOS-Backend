// controllers/receiptController.js
import mongoose from "mongoose";
import Receipt from "../models/Receipt.js";
import Order from "../models/Order.js";
import AdminSettings from "../models/AdminSettings.js";
import PaymentConfig from "../models/PaymentConfig.js";
import MpesaPaymentAttempt from "../models/MpesaPaymentAttempt.js";
import { stkPush, stkQuery } from "../utils/mpesa.js";
import {
  applyPaymentToReceipt,
  applyRewardRedemption,
  creditCashback,
  findCustomerByIdentifier,
} from "../utils/walletPayments.js";

// ---- split out into controllers/receipt/*, re-exported so routes/receiptRoutes.js
//      doesn't need to change its import path ----
export {
  getReceipts,
  getPaidReceipts,
  getPendingOnlineReceipts,
  getReceiptsTodaySummary,
  getReceiptsByWaiter,
  getReceiptById,
  getReceiptHistory,
  getReceiptHistoryByWaiter,
} from "./receipt/receiptQueries.js";
export { addItemsToReceipt, markReceiptPrinted, applyDiscount } from "./receipt/receiptManagement.js";
// ============================================================
// CASH PAYMENT
// ============================================================
// Loads and decrypts this business's M-Pesa config, or throws a
// user-facing error if it's missing/disabled — keeps both call sites
// below from duplicating this logic.
export async function loadMpesaCredentials(req) {
  const config = await req
    .scope(PaymentConfig)
    .findOne({ provider: "mpesa" })
    .select("+consumerKey +consumerSecret +passkey");

  if (!config || !config.enabled) {
    const err = new Error("M-Pesa isn't configured for this business yet");
    err.status = 400;
    throw err;
  }

  const { consumerKey, consumerSecret, passkey } = config.getDecryptedCredentials();
  return {
    shortcode: config.shortcode,
    consumerKey,
    consumerSecret,
    passkey,
    environment: config.environment,
    transactionType: config.shortcodeType === "paybill" ? "CustomerPayBillOnline" : "CustomerBuyGoodsOnline",
    callbackUrl: `${process.env.MPESA_CALLBACK_BASE_URL}/api/receipts/mpesa/callback`,
  };
}
// @desc    Pay a receipt with cash. Change is never allowed to be negative.
// @route   PATCH /api/receipts/:id/pay
// @access  Protected — admin
export const payReceipt = async (req, res) => {
  const { id } = req.params;
  const { amountPaid } = req.body;
  const { businessId } = req;

  const session = await mongoose.startSession();
  try {
    let receipt;
    await session.withTransaction(async () => {
      receipt = await Receipt.findOne({ _id: id, businessId }).session(session);
      if (!receipt) {
        const err = new Error("Receipt not found");
        err.status = 404;
        throw err;
      }
      if (req.shift && !receipt.shift) receipt.shift = req.shift._id;
      if (receipt.status !== "unpaid") {
        const err = new Error("Receipt is already paid or voided");
        err.status = 400;
        throw err;
      }
      const received = parseFloat(amountPaid);
      const owed = receipt.totalDue ?? receipt.subtotal;
      const balanceDue = Number((owed - (receipt.amountPaid || 0)).toFixed(2));
      if (isNaN(received) || received < balanceDue) {
        const err = new Error("Amount received cannot be less than the balance due");
        err.status = 400;
        throw err;
      }

      const changeGiven = Number((received - balanceDue).toFixed(2));

      receipt.status = "paid";
      receipt.paymentMethod = "cash";
      receipt.cashAmount = (receipt.cashAmount || 0) + balanceDue;
      receipt.tillAmount = receipt.tillAmount || 0;
      receipt.amountPaid = owed;
      receipt.changeGiven = changeGiven;
      receipt.paidAt = new Date();
      await cancelActiveAttemptIfAny(receipt, session);
      receipt.payments.push({
        amount: balanceDue,
        method: "cash",
        paidBy: req.user?._id || null,
        paidAt: new Date(),
      });

      // Cashback is earned on the amount actually applied to the bill, not
      // the raw cash handed over (change given isn't real revenue). Runs
      // inside this transaction so the points credit rolls back with
      // everything else if a later step in here fails.
      await creditCashback(receipt, balanceDue, session);

      await receipt.save({ session });

      const updatedOrder = await Order.findOneAndUpdate(
        { _id: receipt.order, businessId },
        { status: "completed" },
        { session }
      );
      if (!updatedOrder) {
        console.warn(
          `payReceipt: receipt ${receipt._id} references order ${receipt.order}, which was not found under businessId ${businessId} — possible cross-tenant data issue`
        );
      }
    });

    // Only reachable once the transaction has actually committed — the
    // frontend is never told a payment succeeded before it's durable.
    const io = req.app.get("io");
    io.emit("receipt:paid", receipt);

    res.json({ message: "Payment successful", receipt });
  } catch (error) {
    if (error.status) {
      return res.status(error.status).json({ message: error.message });
    }
    console.error("Error processing payment:", error.message);
    res.status(500).json({ message: "Failed to process payment", error: error.message });
  } finally {
    session.endSession();
  }
};

// ============================================================
// M-PESA (TILL) PAYMENT — STK PUSH
// ============================================================

// Called from the cash-based payment paths (payReceipt, payCashAndTill,
// payCombo) whenever a bill gets settled while an M-Pesa attempt was still
// mid-flight for it. Marks that attempt "cancelled" rather than leaving it
// "pending"/"unknown" forever — otherwise a late Daraja callback for it
// would land on an already-closed bill and (correctly) get refused and
// flagged for manual reconciliation, which is the right outcome but an
// avoidable one if we know right now that the bill moved on.
  export async function cancelActiveAttemptIfAny(receipt, session = null) {
  if (!receipt.mpesaActiveAttempt) return;
  await MpesaPaymentAttempt.updateOne(
    { _id: receipt.mpesaActiveAttempt, status: { $in: ["pending", "processing", "unknown"] } },
    { $set: { status: "cancelled", cancelledAt: new Date() } },
    { session }
  );
  receipt.mpesaStatus = receipt.mpesaStatus === "pending" ? "idle" : receipt.mpesaStatus;
}

// Shared: mark an attempt (and its receipt) paid once Daraja confirms
// success. Used by the webhook, the manual poll, and the sweep — all of
// which now go through the SAME atomic claim on the attempt row (see
// claimAttemptForFinalization below), so this can only ever run once per
// attempt no matter how many of those three race each other.
//
// Runs inside a transaction: the receipt save, the order update, and the
// attempt's own "succeeded" write all commit together or not at all.
const finalizeAttemptSuccess = async ({ attempt, mpesaReceiptNumber, resultCode, resultDesc, io }) => {
  const session = await mongoose.startSession();
  let outcome;
  try {
    await session.withTransaction(async () => {
      const receipt = await Receipt.findOne({ _id: attempt.receiptId, businessId: attempt.businessId }).session(session);

      // The bill may have already been fully settled by another method
      // (cash, a different attempt, reward) while this STK prompt was
      // still out. Never silently re-apply money to an already-closed
      // bill — record it and surface it for a human instead.
      if (!receipt || receipt.status === "paid" || receipt.status === "voided") {
        await MpesaPaymentAttempt.updateOne(
          { _id: attempt._id },
          { $set: { status: "succeeded-unapplied", resultCode, resultDesc, mpesaReceiptNumber, resolvedAt: new Date() } },
          { session }
        );
        outcome = { applied: false, receipt: receipt || null };
        return;
      }

      if (attempt.source === "wallet") {
        receipt.mpesaStatus = "success";
        receipt.mpesaReceiptNumber = mpesaReceiptNumber || receipt.mpesaReceiptNumber || null;
        receipt.mpesaResultDesc = "Payment received successfully";
        receipt.pendingTillAmount = 0;
        receipt.pendingCashAmount = 0;

        const updated = await applyPaymentToReceipt({
          receipt,
          amount: attempt.amount,
          method: "mpesa_stk",
          reference: receipt.mpesaReceiptNumber,
          paidBy: attempt.paidBy,
          session,
        });

        await MpesaPaymentAttempt.updateOne(
          { _id: attempt._id },
          { $set: { status: "succeeded", resultCode, resultDesc, mpesaReceiptNumber, resolvedAt: new Date() } },
          { session }
        );

        outcome = { applied: true, receipt: updated };
      } else {
        const cashAmount = attempt.cashAmount || 0;
        const tillAmount = attempt.amount || 0;

        receipt.status = "paid";
        receipt.paymentMethod = cashAmount > 0 ? "both" : "mpesa_till";
        receipt.cashAmount = (receipt.cashAmount || 0) + cashAmount;
        receipt.tillAmount = (receipt.tillAmount || 0) + tillAmount;
        receipt.amountPaid = receipt.totalDue ?? receipt.subtotal;
        receipt.changeGiven = 0;
        receipt.paidAt = new Date();
        receipt.mpesaStatus = "success";
        receipt.mpesaReceiptNumber = mpesaReceiptNumber || receipt.mpesaReceiptNumber || null;
        receipt.mpesaResultDesc = "Payment received successfully";
        if (cashAmount > 0) {
          receipt.payments.push({ amount: cashAmount, method: "cash", paidAt: new Date() });
        }
        receipt.payments.push({
          amount: tillAmount,
          method: "mpesa_till",
          reference: receipt.mpesaReceiptNumber,
          paidAt: new Date(),
        });

        await creditCashback(receipt, cashAmount + tillAmount, session);
        await receipt.save({ session });

        const updatedOrder = await Order.findOneAndUpdate(
          { _id: receipt.order, businessId: receipt.businessId },
          { status: "completed" },
          { session }
        );
        if (!updatedOrder) {
          console.warn(
            `finalizeAttemptSuccess: receipt ${receipt._id} references order ${receipt.order}, which was not found under businessId ${receipt.businessId} — possible cross-tenant data issue`
          );
        }

        await MpesaPaymentAttempt.updateOne(
          { _id: attempt._id },
          { $set: { status: "succeeded", resultCode, resultDesc, mpesaReceiptNumber, resolvedAt: new Date() } },
          { session }
        );

        outcome = { applied: true, receipt };
      }
    });
  } finally {
    session.endSession();
  }

  if (!outcome.applied) {
    console.error(
      `⚠️ MANUAL RECONCILIATION NEEDED: M-Pesa attempt ${attempt._id} succeeded (receipt# ${mpesaReceiptNumber}) but its bill ${attempt.receiptId} is ${outcome.receipt ? `already "${outcome.receipt.status}"` : "missing"} — payment was NOT applied. Check whether the customer was charged and reconcile manually.`
    );
    if (io) {
      io.emit("mpesa:result", { checkoutRequestId: attempt.checkoutRequestId, status: "succeeded-unapplied", attemptId: attempt._id });
    }
    return;
  }

  const { receipt } = outcome;
  if (io) {
    io.emit("receipt:updated", receipt);
    if (receipt.status === "paid") io.emit("receipt:paid", receipt);
    io.emit("mpesa:result", { checkoutRequestId: attempt.checkoutRequestId, status: "success", receipt });
  }
};

const finalizeAttemptFailure = async ({ attempt, resultCode, resultDesc, io }) => {
  await MpesaPaymentAttempt.updateOne(
    { _id: attempt._id },
    { $set: { status: "failed", resultCode: resultCode ?? null, resultDesc, resolvedAt: new Date() } }
  );

  const receipt = await Receipt.findOne({ _id: attempt.receiptId, businessId: attempt.businessId });
  // Only touch the receipt's cached fields if it's still pointing at THIS
  // attempt — if it's since moved on to a newer attempt, leave it alone.
  if (receipt && String(receipt.mpesaActiveAttempt) === String(attempt._id)) {
    receipt.mpesaStatus = "failed";
    receipt.mpesaResultDesc = resultDesc || "Payment was not completed";
    await receipt.save();
  }

  if (io) {
    io.emit("mpesa:result", {
      checkoutRequestId: attempt.checkoutRequestId,
      status: "failed",
      message: resultDesc,
    });
  }
};

// Atomically claims a pending/unknown attempt for finalization. Returns the
// claimed attempt, or null if it was already claimed/settled by a
// concurrent callback, poll, or sweep — or if it was cancelled (handled
// separately, see handleUnclaimedCallback). This single operation is what
// makes duplicate Safaricom callbacks, and races between the webhook and a
// manual status check, safe to happen simultaneously without
// double-processing.
//
// "unknown" is claimable on purpose: that's the state an attempt is left in
// when we couldn't tell whether our STK request actually reached Daraja
// (timeout/network error at initiation). A late callback or a manual
// reconciliation query for that same checkoutRequestId is exactly what
// resolves that ambiguity — it should NOT be locked out just because we
// were unsure at the time.
  export async function claimAttemptForFinalization(checkoutRequestId) {
  return MpesaPaymentAttempt.findOneAndUpdate(
    { checkoutRequestId, status: { $in: ["pending", "unknown"] }, _bypassTenantGuard: true },
    { $set: { status: "processing", processingStartedAt: new Date() } },
    { new: true }
  );
}

// If something fails after claiming but before we finalize, release the
// claim back to "pending" so a later poll or sweep can retry it — otherwise
// it's stuck in "processing" forever.
export async function releaseAttemptClaim(attempt) {
  try {
    await MpesaPaymentAttempt.updateOne(
      { _id: attempt._id, status: "processing" },
      { $set: { status: "pending" } }
    );
  } catch (err) {
    console.error("Failed to release M-Pesa attempt processing claim:", err.message);
  }
}

// Called when claimAttemptForFinalization finds nothing claimable. Distinguishes
// three cases: a genuinely unknown checkoutRequestId (nothing we ever created),
// a duplicate delivery for an attempt that's already resolved (correct to
// no-op), and — the important one — a callback landing on an attempt the
// cashier already cancelled. That last case means Safaricom is reporting a
// charge for a payment staff believe never happened; it must never be
// silently dropped OR silently auto-applied, so it's recorded as
// "succeeded-unapplied" and logged loudly for a human to check.
async function handleUnclaimedCallback({ checkoutRequestId, resultCode, resultDesc, mpesaReceiptNumber }) {
  const existing = await MpesaPaymentAttempt.findOne({ checkoutRequestId, _bypassTenantGuard: true });
  if (!existing) {
    console.warn(`M-Pesa callback for a totally unknown checkoutRequestId ${checkoutRequestId} — ResultCode ${resultCode}`);
    return;
  }

  if (existing.status === "cancelled" && Number(resultCode) === 0) {
    await MpesaPaymentAttempt.updateOne(
      { _id: existing._id },
      {
        $set: {
          status: "succeeded-unapplied",
          resultCode: Number(resultCode),
          resultDesc,
          mpesaReceiptNumber,
          resolvedAt: new Date(),
        },
      }
    );
    console.error(
      `⚠️ MANUAL RECONCILIATION NEEDED: M-Pesa attempt ${existing._id} (receipt ${existing.receiptId}) was cancelled by staff but Safaricom reports it SUCCEEDED (receipt# ${mpesaReceiptNumber}). Payment was NOT applied — check whether the customer was charged and reconcile manually.`
    );
    return;
  }

  console.warn(`M-Pesa callback ignored for attempt ${existing._id} — status is already "${existing.status}"`);
}
// @desc    Trigger an STK push ("Prompt"). cashAmount = 0 for prompt-only, or
//          a partial amount for a split "both" payment (prompt covers the rest).
// @route   POST /api/receipts/:id/mpesa/initiate
// @access  Protected — admin
export const initiateMpesaPayment = async (req, res) => {
  const { id } = req.params;
  let { phone, cashAmount } = req.body;
  const { businessId } = req;

  try {
    const receipt = await Receipt.findOne({ _id: id, businessId });
    if (!receipt) return res.status(404).json({ message: "Receipt not found" });
    if (req.shift && !receipt.shift) receipt.shift = req.shift._id;
    if (receipt.status !== "unpaid") {
      return res.status(400).json({ message: "Receipt is already paid or voided" });
    }
    if (receipt.mpesaStatus === "pending") {
      return res.status(409).json({
        message: `A payment prompt was already sent to ${receipt.mpesaPhone} for this bill and is still waiting on the customer.`,
        alreadyPending: true,
        receipt,
      });
    }

    if (!phone) {
      return res.status(400).json({ message: "M-Pesa phone number is required" });
    }

    const owed = receipt.totalDue ?? receipt.subtotal;
    const balanceDue = Number((owed - (receipt.amountPaid || 0)).toFixed(2));
    cashAmount = parseFloat(cashAmount) || 0;
    if (cashAmount < 0) {
      return res.status(400).json({ message: "Cash amount cannot be negative" });
    }
    if (cashAmount >= balanceDue) {
      return res.status(400).json({
        message: "Cash amount covers the full balance — use Cash payment instead",
      });
    }

    const tillAmount = Number((balanceDue - cashAmount).toFixed(2));

    const credentials = await loadMpesaCredentials(req);

    // Durable record created BEFORE calling Daraja. If the request times
    // out after Daraja actually received it, this row (left in "unknown"
    // below) is what lets a later callback or reconciliation still find
    // and resolve it — instead of the payment becoming permanently
    // untraceable, matched to nothing.
    const attempt = await MpesaPaymentAttempt.create({
      businessId,
      receiptId: receipt._id,
      source: "staff",
      phone,
      amount: tillAmount,
      cashAmount,
      paidBy: req.user?._id || null,
      status: "initiating",
    });

    let stkRes;
    try {
      stkRes = await stkPush({
        phone,
        amount: tillAmount,
        accountRef: receipt.billId,
        description: `Bill ${receipt.billId}`,
        ...credentials,
      });
    } catch (stkErr) {
      // We genuinely don't know whether Daraja received this — never
      // treat a network/timeout error the same as a clean rejection.
      await MpesaPaymentAttempt.updateOne(
        { _id: attempt._id },
        { $set: { status: "unknown", initiationError: stkErr.message } }
      );
      // Block an immediate retry the same way a normal pending prompt does.
      // No checkoutRequestId to store — Daraja never responded — so only
      // mpesaStatus changes; the guard above no longer requires one.
      receipt.mpesaStatus = "pending";
      await receipt.save();
      throw stkErr;
    }

    if (String(stkRes.ResponseCode) !== "0") {
      await MpesaPaymentAttempt.updateOne(
        { _id: attempt._id },
        {
          $set: {
            status: "failed",
            initiationError: stkRes.ResponseDescription || "Rejected by Daraja",
            resolvedAt: new Date(),
          },
        }
      );
      return res.status(400).json({
        message: stkRes.ResponseDescription || "Failed to initiate M-Pesa payment",
      });
    }

    await MpesaPaymentAttempt.updateOne(
      { _id: attempt._id },
      {
        $set: {
          status: "pending",
          checkoutRequestId: stkRes.CheckoutRequestID,
          merchantRequestId: stkRes.MerchantRequestID,
          initiatedAt: new Date(),
        },
      }
    );

    receipt.mpesaSource = "staff";
    receipt.mpesaPhone = phone;
    receipt.mpesaCheckoutRequestId = stkRes.CheckoutRequestID;
    receipt.mpesaMerchantRequestId = stkRes.MerchantRequestID;
    receipt.mpesaStatus = "pending";
    receipt.mpesaResultDesc = null;
    receipt.mpesaReceiptNumber = null;
    receipt.pendingCashAmount = cashAmount;
    receipt.pendingTillAmount = tillAmount;
    receipt.mpesaInitiatedAt = new Date();
    receipt.mpesaActiveAttempt = attempt._id;
    await receipt.save();

    const io = req.app.get("io");
    io.emit("receipt:mpesaPending", receipt);

    res.json({
      message: "STK push sent. Ask the customer to enter their M-Pesa PIN.",
      checkoutRequestId: stkRes.CheckoutRequestID,
      tillAmount,
      cashAmount,
    });
  } catch (error) {
    console.error("Error initiating M-Pesa payment:", error.response?.data || error.message);
    res.status(error.status || 500).json({
      message:
        error.response?.data?.errorMessage ||
        error.message ||
        "Failed to initiate M-Pesa payment",
    });
  }
};
// @desc    Daraja calls this once the customer responds to the STK prompt
// @route   POST /api/receipts/mpesa/callback
// @access  Public (Safaricom webhook)
export const mpesaCallback = async (req, res) => {
  res.status(200).json({ message: "Callback received" }); // ack immediately regardless of outcome

  let attempt;
  try {
    const callback = req.body?.Body?.stkCallback;
    if (!callback) return;

    const { CheckoutRequestID, ResultCode, ResultDesc, CallbackMetadata } = callback;
    if (!CheckoutRequestID) return;

    const items = CallbackMetadata?.Item || [];
    const mpesaReceiptNumber = items.find((i) => i.Name === "MpesaReceiptNumber")?.Value || null;

    attempt = await claimAttemptForFinalization(CheckoutRequestID);
    if (!attempt) {
      await handleUnclaimedCallback({ checkoutRequestId: CheckoutRequestID, resultCode: ResultCode, resultDesc: ResultDesc, mpesaReceiptNumber });
      return;
    }

    const io = req.app.get("io");

    if (Number(ResultCode) === 0) {
      await finalizeAttemptSuccess({ attempt, mpesaReceiptNumber, resultCode: Number(ResultCode), resultDesc: ResultDesc, io });
    } else {
      await finalizeAttemptFailure({ attempt, resultCode: Number(ResultCode), resultDesc: ResultDesc, io });
    }
  } catch (error) {
    console.error("M-Pesa callback error:", error.message);
    if (attempt) await releaseAttemptClaim(attempt);
  }
};

// @desc    Poll payment status. Also actively queries Daraja, so payment
//          still completes even if the callback URL can't be reached.
// @route   GET /api/receipts/:id/mpesa/status
// @access  Protected — admin
export const getMpesaStatus = async (req, res) => {
  const { businessId } = req;
  try {
    const receipt = await Receipt.findOne({ _id: req.params.id, businessId });
    if (!receipt) return res.status(404).json({ message: "Receipt not found" });

    if (receipt.status === "paid") return res.json({ status: "success", receipt });

    if (receipt.mpesaStatus !== "pending" || !receipt.mpesaCheckoutRequestId) {
      // "processing" means a callback may be mid-flight right now — tell
      // the caller to check again shortly instead of racing it.
      const status = receipt.mpesaStatus === "processing" ? "pending" : (receipt.mpesaStatus || "idle");
      return res.json({ status, receipt });
    }

    const attempt = await claimAttemptForFinalization(receipt.mpesaCheckoutRequestId);
    if (!attempt) return res.json({ status: "pending", receipt, note: "Reconciliation already in progress" });

    const io = req.app.get("io");
    try {
      const credentials = await loadMpesaCredentials(req);
      const queryRes = await stkQuery({ checkoutRequestId: attempt.checkoutRequestId, ...credentials });
      const resultCode = Number(queryRes.ResultCode);

      if (resultCode === 0) {
        await finalizeAttemptSuccess({ attempt, mpesaReceiptNumber: null, resultCode, resultDesc: queryRes.ResultDesc, io });
        const updated = await Receipt.findOne({ _id: receipt._id, businessId });
        return res.json({ status: "success", receipt: updated });
      }
      if (!isNaN(resultCode)) {
        await finalizeAttemptFailure({ attempt, resultCode, resultDesc: queryRes.ResultDesc, io });
        const updated = await Receipt.findOne({ _id: receipt._id, businessId });
        return res.json({ status: "failed", message: queryRes.ResultDesc, receipt: updated });
      }
      await releaseAttemptClaim(attempt);
    } catch (queryErr) {
      console.warn("M-Pesa status query still pending:", queryErr.response?.data || queryErr.message);
      await releaseAttemptClaim(attempt);
    }

    res.json({ status: "pending", receipt });
  } catch (error) {
    console.error("Error checking M-Pesa status:", error.message);
    res.status(500).json({ message: "Failed to check payment status" });
  }
};

// @desc    Cancel a pending STK push so the cashier can retry or switch method
// @route   POST /api/receipts/:id/mpesa/cancel
// @access  Protected — admin
// @desc    Cancel a pending STK push so the cashier can retry or switch method.
//          Does NOT destroy the attempt's checkoutRequestId — if Safaricom
//          later delivers a success for it anyway, that has to be caught
//          and flagged for manual reconciliation, not silently lost.
// @route   POST /api/receipts/:id/mpesa/cancel
// @access  Protected — admin
export const cancelMpesaPayment = async (req, res) => {
  const { businessId } = req;
  try {
    const receipt = await Receipt.findOne({ _id: req.params.id, businessId });
    if (!receipt) return res.status(404).json({ message: "Receipt not found" });

    if (receipt.mpesaActiveAttempt) {
      await MpesaPaymentAttempt.updateOne(
        { _id: receipt.mpesaActiveAttempt, status: { $in: ["pending", "processing", "unknown"] } },
        { $set: { status: "cancelled", cancelledAt: new Date() } }
      );
    }

    receipt.mpesaStatus = "idle";
    receipt.mpesaResultDesc = null;
    receipt.pendingCashAmount = 0;
    receipt.pendingTillAmount = 0;
    // mpesaCheckoutRequestId / mpesaMerchantRequestId are deliberately left
    // as-is on the receipt (a display/history cache) — the attempt itself,
    // not this field, is what a late callback matches against, and the
    // attempt's own checkoutRequestId was never touched above.
    await receipt.save();

    res.json({ message: "Cancelled", receipt });
  } catch (error) {
    console.error("Error cancelling M-Pesa payment:", error.message);
    res.status(500).json({ message: "Failed to cancel" });
  }
};

// @desc    Split payment: part cash in hand + part already paid manually to
//          the till/paybill by the customer. Till portion auto-covers
//          whatever's left after the cash amount — same "auto-covers the
//          rest" pattern as the Cash+Prompt split. Staff-only, so no M-Pesa
//          code / customer name is collected (that's only required on the
//          customer-facing wallet self-pay flow).
// @route   PATCH /api/receipts/:id/pay/cash-till
// @access  Protected — admin
export const payCashAndTill = async (req, res) => {
  const { id } = req.params;
  let { cashAmount } = req.body;
  const { businessId } = req;

  const session = await mongoose.startSession();
  try {
    let receipt;
    await session.withTransaction(async () => {
      receipt = await Receipt.findOne({ _id: id, businessId }).session(session);
      if (!receipt) {
        const err = new Error("Receipt not found");
        err.status = 404;
        throw err;
      }
      if (req.shift && !receipt.shift) receipt.shift = req.shift._id;
      if (receipt.status !== "unpaid") {
        const err = new Error("Receipt is already paid or voided");
        err.status = 400;
        throw err;
      }
      const owed = receipt.totalDue ?? receipt.subtotal;
      const balanceDue = Number((owed - (receipt.amountPaid || 0)).toFixed(2));
      cashAmount = parseFloat(cashAmount);

      if (isNaN(cashAmount) || cashAmount <= 0) {
        const err = new Error("Cash amount must be more than 0");
        err.status = 400;
        throw err;
      }
      if (cashAmount >= balanceDue) {
        const err = new Error("Cash amount covers the full balance — use Cash payment instead");
        err.status = 400;
        throw err;
      }

      const tillAmount = Number((balanceDue - cashAmount).toFixed(2));

      receipt.status = "paid";
      receipt.paymentMethod = "both";
      receipt.cashAmount = (receipt.cashAmount || 0) + cashAmount;
      receipt.tillAmount = (receipt.tillAmount || 0) + tillAmount;
      receipt.amountPaid = owed;
      receipt.changeGiven = 0;
      receipt.paidAt = new Date();
      await cancelActiveAttemptIfAny(receipt, session);
      receipt.payments.push(
        { amount: cashAmount, method: "cash", paidBy: req.user?._id || null, paidAt: new Date() },
        { amount: tillAmount, method: "manual_till", paidBy: req.user?._id || null, paidAt: new Date() }
      );

      // Cashback on the full balance just settled (cash + till combined).
      // Runs inside this transaction, same as payReceipt.
      await creditCashback(receipt, cashAmount + tillAmount, session);

      await receipt.save({ session });

      const updatedOrder = await Order.findOneAndUpdate(
        { _id: receipt.order, businessId },
        { status: "completed" },
        { session }
      );
      if (!updatedOrder) {
        console.warn(
          `payCashAndTill: receipt ${receipt._id} references order ${receipt.order}, which was not found under businessId ${businessId} — possible cross-tenant data issue`
        );
      }
    });

    const io = req.app.get("io");
    io.emit("receipt:paid", receipt);

    res.json({ message: "Payment successful", receipt });
  } catch (error) {
    if (error.status) {
      return res.status(error.status).json({ message: error.message });
    }
    console.error("Error processing cash+till payment:", error.message);
    res.status(500).json({ message: "Failed to process payment", error: error.message });
  } finally {
    session.endSession();
  }
};

// ============================================================
// COMBO PAYMENT — cash + till + reward in one action
// ============================================================

// @desc    Apply any mix of cash, manual-till, and a customer's reward
//          points to a bill in a single call. Any leftover balance (e.g.
//          the rest is going on M-Pesa prompt) is left due — call
//          POST /:id/mpesa/initiate next for that remainder.
// @route   PATCH /api/receipts/:id/pay/combo
// @access  Protected — admin, accountant (payments permission + open shift)
export const payCombo = async (req, res) => {
  const { id } = req.params;
  let { cashAmount, tillAmount, rewardIdentifier, rewardAmount } = req.body;

  cashAmount = parseFloat(cashAmount) || 0;
  tillAmount = parseFloat(tillAmount) || 0;
  rewardAmount = parseFloat(rewardAmount) || 0;

  if (cashAmount < 0 || tillAmount < 0 || rewardAmount < 0) {
    return res.status(400).json({ message: "Amounts cannot be negative" });
  }
  if (cashAmount === 0 && tillAmount === 0 && rewardAmount === 0) {
    return res.status(400).json({ message: "Enter at least one amount" });
  }

  const { businessId } = req;
  const session = await mongoose.startSession();

  try {
    let receipt;
    let balanceRemaining = 0;

    await session.withTransaction(async () => {
      receipt = await Receipt.findOne({ _id: id, businessId }).session(session);
      if (!receipt) {
        const err = new Error("Receipt not found");
        err.status = 404;
        throw err;
      }
      if (receipt.status !== "unpaid") {
        const err = new Error("Receipt is already paid or voided");
        err.status = 400;
        throw err;
      }
      if (req.shift && !receipt.shift) receipt.shift = req.shift._id;

      const owed = receipt.totalDue ?? receipt.subtotal;
      const balanceBefore = Number((owed - (receipt.amountPaid || 0)).toFixed(2));
      const combinedAmount = Number((cashAmount + tillAmount + rewardAmount).toFixed(2));
      if (Math.abs(combinedAmount - balanceBefore) > 0.01) {
        const err = new Error(
          combinedAmount < balanceBefore
            ? `Amount entered (KES ${combinedAmount.toLocaleString()}) is less than the balance due (KES ${balanceBefore.toLocaleString()}) — make up the full amount to complete this payment`
            : `Combined amount cannot exceed the balance due (KES ${balanceBefore.toLocaleString()})`
        );
        err.status = 400;
        throw err;
      }

      // Any payment applied here supersedes an in-flight M-Pesa attempt on
      // this bill, regardless of which combination of legs below actually
      // runs — cancel it once, up front.
      await cancelActiveAttemptIfAny(receipt, session);

      // ---- Reward leg first — needs the customer's own points balance ----
      if (rewardAmount > 0) {
        if (!rewardIdentifier || !rewardIdentifier.trim()) {
          const err = new Error("Customer email or phone is required to redeem reward points");
          err.status = 400;
          throw err;
        }
        const customer = await findCustomerByIdentifier(rewardIdentifier, businessId);
        if (!customer) {
          const err = new Error("No registered customer found with that email or phone");
          err.status = 404;
          throw err;
        }
        const settings = await AdminSettings.getSettings(businessId);
        const pointValue = settings.reward.pointValueKes || 1;
        const pointsToRedeem = Math.ceil(rewardAmount / pointValue);
        if (pointsToRedeem > (customer.walletPoints || 0)) {
          const err = new Error(`${customer.fullName} only has ${customer.walletPoints} points available`);
          err.status = 400;
          throw err;
        }
        await applyRewardRedemption({ receipt, user: customer, pointsToRedeem, session });
        // applyRewardRedemption already saved the receipt, inside this same
        // transaction — keep working off the same in-memory doc, it's current.
      }

      // ---- Cash / till legs ----
      if (cashAmount > 0) {
        receipt.cashAmount = (receipt.cashAmount || 0) + cashAmount;
        receipt.payments.push({ amount: cashAmount, method: "cash", paidBy: req.user?._id || null, paidAt: new Date() });
        await creditCashback(receipt, cashAmount, session);
      }
      if (tillAmount > 0) {
        receipt.tillAmount = (receipt.tillAmount || 0) + tillAmount;
        receipt.payments.push({ amount: tillAmount, method: "manual_till", paidBy: req.user?._id || null, paidAt: new Date() });
        await creditCashback(receipt, tillAmount, session);
      }

      if (cashAmount > 0 || tillAmount > 0) {
        const totalPaid = receipt.payments.reduce((sum, p) => sum + p.amount, 0);
        receipt.amountPaid = Number(totalPaid.toFixed(2));
        receipt.paymentMethod = receipt.payments.length > 1 ? "both" : cashAmount > 0 ? "cash" : "manual_till";
        receipt.status = totalPaid >= owed ? "paid" : "partial";
        if (receipt.status === "paid") receipt.paidAt = new Date();
        await receipt.save({ session });
      }

      if (receipt.status === "paid") {
        const updatedOrder = await Order.findOneAndUpdate(
          { _id: receipt.order, businessId },
          { status: "completed" },
          { session }
        );
        if (!updatedOrder) {
          console.warn(
            `payCombo: receipt ${receipt._id} references order ${receipt.order}, which was not found under businessId ${businessId} — possible cross-tenant data issue`
          );
        }
      }

      balanceRemaining = Number((owed - (receipt.amountPaid || 0)).toFixed(2));
    });

    // Only reachable once the transaction has actually committed — the
    // frontend is never told a payment succeeded before it's durable.
    const io = req.app.get("io");
    if (io) {
      io.emit("receipt:updated", receipt);
      if (receipt.status === "paid") io.emit("receipt:paid", receipt);
    }

    res.json({
      message: receipt.status === "paid" ? "Payment complete" : `Applied — KES ${balanceRemaining.toLocaleString()} still due`,
      receipt,
      balanceRemaining,
    });
  } catch (error) {
    if (error.status) {
      return res.status(error.status).json({ message: error.message });
    }
    console.error("Error processing combo payment:", error.message);
    res.status(500).json({ message: "Failed to process payment", error: error.message });
  } finally {
    session.endSession();
  }
};
// Catches STK pushes that never got a callback AND were never manually
// polled — e.g. cashier closed the app before checking. Runs on an
// interval from server startup (see app.js/server.js wiring below).
const STALE_PENDING_MINUTES = 3;

export async function sweepStalePendingMpesaPayments(io) {
  const cutoff = new Date(Date.now() - STALE_PENDING_MINUTES * 60 * 1000);

  // "unknown" is included deliberately — that's the state left behind when
  // we couldn't tell whether an STK request reached Daraja at all. If it
  // did, and Daraja actually issued a checkoutRequestId, stkQuery below can
  // still resolve it even though our own initiation response was lost.
  const staleAttempts = await MpesaPaymentAttempt.find({
    status: { $in: ["pending", "unknown"] },
    checkoutRequestId: { $type: "string" },
    createdAt: { $lte: cutoff },
    _bypassTenantGuard: true, // platform-wide sweep, not scoped to one business
  });

  for (const attempt of staleAttempts) {
    const claimed = await claimAttemptForFinalization(attempt.checkoutRequestId);
    if (!claimed) continue; // already handled elsewhere in the meantime

    try {
      const config = await PaymentConfig.findOne({
        businessId: claimed.businessId,
        provider: "mpesa",
        _bypassTenantGuard: true,
      }).select("+consumerKey +consumerSecret +passkey");

      if (!config || !config.enabled) {
        await releaseAttemptClaim(claimed);
        continue;
      }
      const { consumerKey, consumerSecret, passkey } = config.getDecryptedCredentials();

      const queryRes = await stkQuery({
        checkoutRequestId: claimed.checkoutRequestId,
        shortcode: config.shortcode,
        consumerKey,
        consumerSecret,
        passkey,
        environment: config.environment,
      });
      const resultCode = Number(queryRes.ResultCode);

      if (resultCode === 0) {
        await finalizeAttemptSuccess({ attempt: claimed, mpesaReceiptNumber: null, resultCode, resultDesc: queryRes.ResultDesc, io });
      } else if (!isNaN(resultCode)) {
        await finalizeAttemptFailure({ attempt: claimed, resultCode, resultDesc: queryRes.ResultDesc, io });
      } else {
        await releaseAttemptClaim(claimed);
      }
    } catch (err) {
      console.warn(`Sweep: still unresolved for ${claimed.checkoutRequestId}:`, err.message);
      await releaseAttemptClaim(claimed);
    }
  }

  // Attempts that never even got a checkoutRequestId back from Daraja (the
  // initiation request itself errored/timed out before a response arrived)
  // can't be resolved by querying Daraja — there's no ID to query with.
  // These need a human, not a retry loop; at minimum, surface them.
  const untraceable = await MpesaPaymentAttempt.find({
    status: "unknown",
    checkoutRequestId: null,
    createdAt: { $lte: cutoff },
    _bypassTenantGuard: true,
  }).select("_id receiptId businessId createdAt initiationError");

  untraceable.forEach((a) => {
    console.error(
      `⚠️ MANUAL REVIEW NEEDED: M-Pesa attempt ${a._id} (receipt ${a.receiptId}, business ${a.businessId}) never received a checkoutRequestId from Daraja (${a.initiationError || "no error recorded"}) and can't be auto-reconciled — check with the customer/Safaricom directly.`
    );
  });
}
// @desc    Force-reconcile every currently-pending/unknown M-Pesa attempt for
//          this business — same query-and-finalize path as the automatic sweep.
// @route   POST /api/receipts/mpesa/reconcile
// @access  Protected — admin
export const reconcilePendingMpesaPayments = async (req, res) => {
  const { businessId } = req;
  try {
    const staleAttempts = await MpesaPaymentAttempt.find({
      businessId,
      status: { $in: ["pending", "unknown"] },
      checkoutRequestId: { $type: "string" },
    });
    const io = req.app.get("io");
    const results = [];

    for (const attempt of staleAttempts) {
      const claimed = await claimAttemptForFinalization(attempt.checkoutRequestId);
      if (!claimed) {
        results.push({ attemptId: attempt._id, receiptId: attempt.receiptId, outcome: "skipped-in-progress" });
        continue;
      }
      try {
        const credentials = await loadMpesaCredentials(req);
        const queryRes = await stkQuery({ checkoutRequestId: claimed.checkoutRequestId, ...credentials });
        const resultCode = Number(queryRes.ResultCode);

        if (resultCode === 0) {
          await finalizeAttemptSuccess({ attempt: claimed, mpesaReceiptNumber: null, resultCode, resultDesc: queryRes.ResultDesc, io });
          results.push({ attemptId: claimed._id, receiptId: claimed.receiptId, outcome: "success" });
        } else if (!isNaN(resultCode)) {
          await finalizeAttemptFailure({ attempt: claimed, resultCode, resultDesc: queryRes.ResultDesc, io });
          results.push({ attemptId: claimed._id, receiptId: claimed.receiptId, outcome: "failed", message: queryRes.ResultDesc });
        } else {
          await releaseAttemptClaim(claimed);
          results.push({ attemptId: claimed._id, receiptId: claimed.receiptId, outcome: "still-pending" });
        }
      } catch (err) {
        await releaseAttemptClaim(claimed);
        results.push({ attemptId: claimed._id, receiptId: claimed.receiptId, outcome: "error", message: err.message });
      }
    }

    const untraceable = await MpesaPaymentAttempt.find({
      businessId,
      status: "unknown",
      checkoutRequestId: null,
    }).select("_id receiptId");
    untraceable.forEach((a) =>
      results.push({ attemptId: a._id, receiptId: a.receiptId, outcome: "untraceable-needs-manual-review" })
    );

    res.json({ message: `Reconciled ${results.length} attempt(s)`, results });
  } catch (error) {
    console.error("Manual M-Pesa reconciliation error:", error.message);
    res.status(500).json({ message: "Reconciliation failed", error: error.message });
  }
};
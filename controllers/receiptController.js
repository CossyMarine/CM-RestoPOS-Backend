// controllers/receiptController.js
import mongoose from "mongoose";
import Receipt from "../models/Receipt.js";
import Order from "../models/Order.js";
import AdminSettings from "../models/AdminSettings.js";
import PaymentConfig from "../models/PaymentConfig.js";
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
async function loadMpesaCredentials(req) {
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
      receipt.mpesaStatus = receipt.mpesaStatus === "pending" ? "idle" : receipt.mpesaStatus;
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

// Shared: mark a receipt paid once Daraja confirms success (staff-initiated flow)
const finalizeMpesaSuccess = async ({ receipt, mpesaReceiptNumber, io }) => {
  const cashAmount = receipt.pendingCashAmount || 0;
  const tillAmount = receipt.pendingTillAmount || 0;

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

  // Cashback on the full amount just settled (cash portion + till portion).
  await creditCashback(receipt, cashAmount + tillAmount);

  await receipt.save();

  // No req here — finalizeMpesaSuccess is shared by the staff-initiated flow
  // AND the Safaricom webhook/poll path, neither of which can be trusted to
  // always have req.businessId. The receipt is already a tenant-scoped doc
  // (it was fetched with businessId or _bypassTenantGuard earlier), so scope
  // off of it instead.
  const updatedOrder = await Order.findOneAndUpdate(
    { _id: receipt.order, businessId: receipt.businessId },
    { status: "completed" }
  );
  if (!updatedOrder) {
    console.warn(
      `finalizeMpesaSuccess: receipt ${receipt._id} references order ${receipt.order}, which was not found under businessId ${receipt.businessId} — possible cross-tenant data issue`
    );
  }

  io.emit("receipt:paid", receipt);
  io.emit("mpesa:result", {
    checkoutRequestId: receipt.mpesaCheckoutRequestId,
    status: "success",
    receipt,
  });
};

// Shared: apply a wallet-initiated STK push once Daraja confirms success —
// goes through applyPaymentToReceipt so partial payments and cashback work
const finalizeWalletMpesaSuccess = async ({ receipt, mpesaReceiptNumber, io }) => {
  const amount = receipt.pendingTillAmount || 0;
  const paidBy = receipt.pendingPaidBy;

  receipt.mpesaStatus = "success";
  receipt.mpesaReceiptNumber = mpesaReceiptNumber || receipt.mpesaReceiptNumber || null;
  receipt.mpesaResultDesc = "Payment received successfully";
  receipt.pendingTillAmount = 0;
  receipt.pendingCashAmount = 0;

  const updated = await applyPaymentToReceipt({
    receipt,
    amount,
    method: "mpesa_stk",
    reference: receipt.mpesaReceiptNumber,
    paidBy,
  });

  io.emit("receipt:updated", updated);
  if (updated.status === "paid") io.emit("receipt:paid", updated);

  io.emit("mpesa:result", {
    checkoutRequestId: updated.mpesaCheckoutRequestId,
    status: "success",
    receipt: updated,
  });
};

const finalizeMpesaFailure = async ({ receipt, resultDesc, io }) => {
  receipt.mpesaStatus = "failed";
  receipt.mpesaResultDesc = resultDesc || "Payment was not completed";
  await receipt.save();

  io.emit("mpesa:result", {
    checkoutRequestId: receipt.mpesaCheckoutRequestId,
    status: "failed",
    message: receipt.mpesaResultDesc,
  });
};

// @desc    Trigger an STK push ("Prompt"). cashAmount = 0 for prompt-only, or
//          a partial amount for a split "both" payment (prompt covers the rest).
// @route   POST /api/receipts/:id/mpesa/initiate
// @access  Protected — admin
// @desc    Trigger an STK push ("Prompt"). cashAmount = 0 for prompt-only, or
//          a partial amount for a split "both" payment (prompt covers the rest).
// @route   POST /api/receipts/:id/mpesa/initiate
// @access  Protected — admin
// Atomically claims a pending receipt for processing. Returns the claimed
// receipt, or null if it was already claimed/settled by a concurrent
// callback, poll, or sweep. This single operation is what makes duplicate
// Safaricom callbacks — and races between the webhook and a manual status
// check — safe to happen simultaneously without double-processing.
async function claimPendingReceipt({ checkoutRequestId, businessId }) {
  const filter = { mpesaCheckoutRequestId: checkoutRequestId, mpesaStatus: "pending" };
  if (businessId) {
    filter.businessId = businessId;
  } else {
    filter._bypassTenantGuard = true; // public webhook — businessId not known yet
  }

  return Receipt.findOneAndUpdate(filter, { $set: { mpesaStatus: "processing" } }, { new: true });
}

// If something fails after claiming but before we finalize, release the
// claim back to "pending" so a later poll or sweep can retry it — otherwise
// it's stuck in "processing" forever.
async function releaseClaim(receipt) {
  try {
    await Receipt.updateOne(
      { _id: receipt._id, mpesaStatus: "processing" },
      { $set: { mpesaStatus: "pending" } }
    );
  } catch (err) {
    console.error("Failed to release M-Pesa processing claim:", err.message);
  }
}
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
    if (receipt.mpesaStatus === "pending" && receipt.mpesaCheckoutRequestId) {
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

    // NEW — load this business's own M-Pesa credentials instead of global env vars
    const credentials = await loadMpesaCredentials(req);

    const stkRes = await stkPush({
      phone,
      amount: tillAmount,
      accountRef: receipt.billId,
      description: `Bill ${receipt.billId}`,
      ...credentials,
    });

    if (String(stkRes.ResponseCode) !== "0") {
      return res.status(400).json({
        message: stkRes.ResponseDescription || "Failed to initiate M-Pesa payment",
      });
    }

    receipt.mpesaSource = "staff";
    receipt.mpesaPhone = phone;
    receipt.mpesaCheckoutRequestId = stkRes.CheckoutRequestID;
    receipt.mpesaMerchantRequestId = stkRes.MerchantRequestID;
    receipt.mpesaStatus = "pending";
    receipt.mpesaResultDesc = null;
    receipt.mpesaReceiptNumber = null;
    receipt.pendingCashAmount = cashAmount;
    receipt.pendingTillAmount = tillAmount;
    receipt.mpesaInitiatedAt = new Date()
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

  let receipt;
  try {
    const callback = req.body?.Body?.stkCallback;
    if (!callback) return;

    const { CheckoutRequestID, ResultCode, ResultDesc, CallbackMetadata } = callback;
    if (!CheckoutRequestID) return;

    receipt = await claimPendingReceipt({ checkoutRequestId: CheckoutRequestID });
    if (!receipt) {
      console.warn(`M-Pesa callback ignored — no pending receipt (already processed/unknown) for ${CheckoutRequestID}`);
      return; // duplicate delivery, or a poll/sweep already won the race — correct to no-op
    }

    const io = req.app.get("io");

    if (Number(ResultCode) === 0) {
      const items = CallbackMetadata?.Item || [];
      const mpesaReceiptNumber = items.find((i) => i.Name === "MpesaReceiptNumber")?.Value || null;
      if (receipt.mpesaSource === "wallet") {
        await finalizeWalletMpesaSuccess({ receipt, mpesaReceiptNumber, io });
      } else {
        await finalizeMpesaSuccess({ receipt, mpesaReceiptNumber, io });
      }
    } else {
      await finalizeMpesaFailure({ receipt, resultDesc: ResultDesc, io });
    }
  } catch (error) {
    console.error("M-Pesa callback error:", error.message);
    if (receipt) await releaseClaim(receipt);
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

    const claimed = await claimPendingReceipt({ checkoutRequestId: receipt.mpesaCheckoutRequestId, businessId });
    if (!claimed) return res.json({ status: "pending", receipt, note: "Reconciliation already in progress" });

    const io = req.app.get("io");
    try {
      const credentials = await loadMpesaCredentials(req);
      const queryRes = await stkQuery({ checkoutRequestId: claimed.mpesaCheckoutRequestId, ...credentials });
      const resultCode = Number(queryRes.ResultCode);

      if (resultCode === 0) {
        const finalize = claimed.mpesaSource === "wallet" ? finalizeWalletMpesaSuccess : finalizeMpesaSuccess;
        await finalize({ receipt: claimed, mpesaReceiptNumber: null, io });
        return res.json({ status: "success", receipt: claimed });
      }
      if (!isNaN(resultCode)) {
        await finalizeMpesaFailure({ receipt: claimed, resultDesc: queryRes.ResultDesc, io });
        return res.json({ status: "failed", message: queryRes.ResultDesc, receipt: claimed });
      }
      await releaseClaim(claimed);
    } catch (queryErr) {
      console.warn("M-Pesa status query still pending:", queryErr.response?.data || queryErr.message);
      await releaseClaim(claimed);
    }

    res.json({ status: "pending", receipt: claimed });
  } catch (error) {
    console.error("Error checking M-Pesa status:", error.message);
    res.status(500).json({ message: "Failed to check payment status" });
  }
};

// @desc    Cancel a pending STK push so the cashier can retry or switch method
// @route   POST /api/receipts/:id/mpesa/cancel
// @access  Protected — admin
export const cancelMpesaPayment = async (req, res) => {
  const { businessId } = req;
  try {
    const receipt = await Receipt.findOne({ _id: req.params.id, businessId });
    if (!receipt) return res.status(404).json({ message: "Receipt not found" });

    receipt.mpesaStatus = "idle";
    receipt.mpesaCheckoutRequestId = null;
    receipt.mpesaMerchantRequestId = null;
    receipt.mpesaResultDesc = null;
    receipt.pendingCashAmount = 0;
    receipt.pendingTillAmount = 0;
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
      receipt.mpesaStatus = receipt.mpesaStatus === "pending" ? "idle" : receipt.mpesaStatus;
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

  try {
    const receipt = await Receipt.findOne({ _id: id, businessId });
    if (!receipt) return res.status(404).json({ message: "Receipt not found" });
    if (receipt.status !== "unpaid") {
      return res.status(400).json({ message: "Receipt is already paid or voided" });
    }    if (req.shift && !receipt.shift) receipt.shift = req.shift._id;

    const owed = receipt.totalDue ?? receipt.subtotal;
    const balanceBefore = Number((owed - (receipt.amountPaid || 0)).toFixed(2));
    const combinedAmount = Number((cashAmount + tillAmount + rewardAmount).toFixed(2));
    if (Math.abs(combinedAmount - balanceBefore) > 0.01) {
      return res.status(400).json({
        message:
          combinedAmount < balanceBefore
            ? `Amount entered (KES ${combinedAmount.toLocaleString()}) is less than the balance due (KES ${balanceBefore.toLocaleString()}) — make up the full amount to complete this payment`
            : `Combined amount cannot exceed the balance due (KES ${balanceBefore.toLocaleString()})`,
      });
    }
    const io = req.app.get("io");

    // ---- Reward leg first — needs the customer's own points balance ----
    if (rewardAmount > 0) {
      if (!rewardIdentifier || !rewardIdentifier.trim()) {
        return res.status(400).json({ message: "Customer email or phone is required to redeem reward points" });
      }
      const customer = await findCustomerByIdentifier(rewardIdentifier, businessId);
      if (!customer) {
        return res.status(404).json({ message: "No registered customer found with that email or phone" });
      }
      const settings = await AdminSettings.getSettings(businessId);
      const pointValue = settings.reward.pointValueKes || 1;
      const pointsToRedeem = Math.ceil(rewardAmount / pointValue);
      if (pointsToRedeem > (customer.walletPoints || 0)) {
        return res.status(400).json({
          message: `${customer.fullName} only has ${customer.walletPoints} points available`,
        });
      }
      await applyRewardRedemption({ receipt, user: customer, pointsToRedeem });
      // applyRewardRedemption already saved the receipt — keep working off
      // the same in-memory doc, it's up to date. It no longer emits itself;
      // the single emit at the end of this function covers the receipt's
      // true final state after the cash/till legs below are also applied.
    }

    // ---- Cash / till legs ----
    if (cashAmount > 0) {
      receipt.cashAmount = (receipt.cashAmount || 0) + cashAmount;
      receipt.payments.push({ amount: cashAmount, method: "cash", paidBy: req.user?._id || null, paidAt: new Date() });
      await creditCashback(receipt, cashAmount);
    }
    if (tillAmount > 0) {
      receipt.tillAmount = (receipt.tillAmount || 0) + tillAmount;
      receipt.payments.push({ amount: tillAmount, method: "manual_till", paidBy: req.user?._id || null, paidAt: new Date() });
      await creditCashback(receipt, tillAmount);
    }

    if (cashAmount > 0 || tillAmount > 0) {
      const totalPaid = receipt.payments.reduce((sum, p) => sum + p.amount, 0);
      receipt.amountPaid = Number(totalPaid.toFixed(2));
      receipt.paymentMethod = receipt.payments.length > 1 ? "both" : cashAmount > 0 ? "cash" : "manual_till";
      receipt.status = totalPaid >= owed ? "paid" : "partial";
      if (receipt.status === "paid") receipt.paidAt = new Date();
      receipt.mpesaStatus = receipt.mpesaStatus === "pending" ? "idle" : receipt.mpesaStatus;
      await receipt.save();
    }

    if (receipt.status === "paid") {
      const updatedOrder = await Order.findOneAndUpdate(
        { _id: receipt.order, businessId },
        { status: "completed" }
      );
      if (!updatedOrder) {
        console.warn(
          `payCombo: receipt ${receipt._id} references order ${receipt.order}, which was not found under businessId ${businessId} — possible cross-tenant data issue`
        );
      }
    }

    if (io) {
      io.emit("receipt:updated", receipt);
      if (receipt.status === "paid") io.emit("receipt:paid", receipt);
    }

    const balanceRemaining = Number((owed - (receipt.amountPaid || 0)).toFixed(2));

    res.json({
      message: receipt.status === "paid" ? "Payment complete" : `Applied — KES ${balanceRemaining.toLocaleString()} still due`,
      receipt,
      balanceRemaining,
    });
  } catch (error) {
    console.error("Error processing combo payment:", error.message);
    res.status(400).json({ message: error.message || "Failed to process payment" });
  }
};
// Catches STK pushes that never got a callback AND were never manually
// polled — e.g. cashier closed the app before checking. Runs on an
// interval from server startup (see app.js/server.js wiring below).
const STALE_PENDING_MINUTES = 3;

export async function sweepStalePendingMpesaPayments(io) {
  const cutoff = new Date(Date.now() - STALE_PENDING_MINUTES * 60 * 1000);

  const staleReceipts = await Receipt.find({
    mpesaStatus: "pending",
    mpesaInitiatedAt: { $lte: cutoff },
    _bypassTenantGuard: true, // platform-wide sweep, not scoped to one business
  });

  for (const receipt of staleReceipts) {
    const claimed = await claimPendingReceipt({
      checkoutRequestId: receipt.mpesaCheckoutRequestId,
      businessId: receipt.businessId,
    });
    if (!claimed) continue; // already handled elsewhere in the meantime

    try {
      const config = await PaymentConfig.findOne({
        businessId: receipt.businessId,
        provider: "mpesa",
        _bypassTenantGuard: true,
      }).select("+consumerKey +consumerSecret +passkey");

      if (!config || !config.enabled) {
        await releaseClaim(claimed);
        continue;
      }
      const { consumerKey, consumerSecret, passkey } = config.getDecryptedCredentials();

      const queryRes = await stkQuery({
        checkoutRequestId: claimed.mpesaCheckoutRequestId,
        shortcode: config.shortcode,
        consumerKey,
        consumerSecret,
        passkey,
        environment: config.environment,
      });
      const resultCode = Number(queryRes.ResultCode);

      if (resultCode === 0) {
        const finalize = claimed.mpesaSource === "wallet" ? finalizeWalletMpesaSuccess : finalizeMpesaSuccess;
        await finalize({ receipt: claimed, mpesaReceiptNumber: null, io });
      } else if (!isNaN(resultCode)) {
        await finalizeMpesaFailure({ receipt: claimed, resultDesc: queryRes.ResultDesc, io });
      } else {
        await releaseClaim(claimed);
      }
    } catch (err) {
      console.warn(`Sweep: still unresolved for ${claimed.mpesaCheckoutRequestId}:`, err.message);
      await releaseClaim(claimed);
    }
  }
}
// @desc    Force-reconcile every currently-pending M-Pesa receipt for this
//          business — same query-and-finalize path as the automatic sweep.
// @route   POST /api/receipts/mpesa/reconcile
// @access  Protected — admin
export const reconcilePendingMpesaPayments = async (req, res) => {
  const { businessId } = req;
  try {
    const staleReceipts = await Receipt.find({ businessId, mpesaStatus: "pending" });
    const io = req.app.get("io");
    const results = [];

    for (const receipt of staleReceipts) {
      const claimed = await claimPendingReceipt({ checkoutRequestId: receipt.mpesaCheckoutRequestId, businessId });
      if (!claimed) {
        results.push({ receiptId: receipt._id, outcome: "skipped-in-progress" });
        continue;
      }
      try {
        const credentials = await loadMpesaCredentials(req);
        const queryRes = await stkQuery({ checkoutRequestId: claimed.mpesaCheckoutRequestId, ...credentials });
        const resultCode = Number(queryRes.ResultCode);

        if (resultCode === 0) {
          const finalize = claimed.mpesaSource === "wallet" ? finalizeWalletMpesaSuccess : finalizeMpesaSuccess;
          await finalize({ receipt: claimed, mpesaReceiptNumber: null, io });
          results.push({ receiptId: claimed._id, outcome: "success" });
        } else if (!isNaN(resultCode)) {
          await finalizeMpesaFailure({ receipt: claimed, resultDesc: queryRes.ResultDesc, io });
          results.push({ receiptId: claimed._id, outcome: "failed", message: queryRes.ResultDesc });
        } else {
          await releaseClaim(claimed);
          results.push({ receiptId: claimed._id, outcome: "still-pending" });
        }
      } catch (err) {
        await releaseClaim(claimed);
        results.push({ receiptId: claimed._id, outcome: "error", message: err.message });
      }
    }

    res.json({ message: `Reconciled ${results.length} pending receipt(s)`, results });
  } catch (error) {
    console.error("Manual M-Pesa reconciliation error:", error.message);
    res.status(500).json({ message: "Reconciliation failed", error: error.message });
  }
};
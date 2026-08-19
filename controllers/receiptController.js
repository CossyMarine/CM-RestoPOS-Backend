// controllers/receiptController.js
import Receipt from "../models/Receipt.js";
import Order from "../models/Order.js";
import AdminSettings from "../models/AdminSettings.js";
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

// @desc    Pay a receipt with cash. Change is never allowed to be negative.
// @route   PATCH /api/receipts/:id/pay
// @access  Protected — admin
export const payReceipt = async (req, res) => {
  const { id } = req.params;
  const { amountPaid } = req.body;

  try {
    const receipt = await Receipt.findById(id);
    if (!receipt) return res.status(404).json({ message: "Receipt not found" });
    if (req.shift && !receipt.shift) receipt.shift = req.shift._id;
    if (!["unpaid", "partial"].includes(receipt.status)) {
      return res.status(400).json({ message: "Receipt is already paid or voided" });
    }

    const received = parseFloat(amountPaid);
    const owed = receipt.totalDue ?? receipt.subtotal;
const balanceDue = Number((owed - (receipt.amountPaid || 0)).toFixed(2));
    if (isNaN(received) || received < balanceDue) {
      return res.status(400).json({ message: "Amount received cannot be less than the balance due" });
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
    // the raw cash handed over (change given isn't real revenue).
    await creditCashback(receipt, balanceDue);

    await receipt.save();

    await Order.findByIdAndUpdate(receipt.order, { status: "completed" });

    const io = req.app.get("io");
    io.emit("receipt:paid", receipt);

    res.json({ message: "Payment successful", receipt });
  } catch (error) {
    console.error("Error processing payment:", error.message);
    res.status(500).json({ message: "Failed to process payment", error: error.message });
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

  await Order.findByIdAndUpdate(receipt.order, { status: "completed" });

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
    io,
  });

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
export const initiateMpesaPayment = async (req, res) => {
  const { id } = req.params;
  let { phone, cashAmount } = req.body;

  try {
    const receipt = await Receipt.findById(id);
    if (!receipt) return res.status(404).json({ message: "Receipt not found" });
    if (req.shift && !receipt.shift) receipt.shift = req.shift._id;
    if (!["unpaid", "partial"].includes(receipt.status)) {
      return res.status(400).json({ message: "Receipt is already paid or voided" });
    }

    // A prompt is already out for this bill — don't send a second one.
    // Tell the cashier what's already pending instead of firing again.
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

    const stkRes = await stkPush({
      phone,
      amount: tillAmount,
      accountRef: receipt.billId,
      description: `Bill ${receipt.billId}`,
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
    res.status(500).json({
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
  try {
    const callback = req.body?.Body?.stkCallback;
    if (!callback) return res.status(200).json({ message: "Ignored" });

    const { CheckoutRequestID, ResultCode, ResultDesc, CallbackMetadata } = callback;

    const receipt = await Receipt.findOne({ mpesaCheckoutRequestId: CheckoutRequestID });
    if (!receipt || !["unpaid", "partial"].includes(receipt.status)) {
      return res.status(200).json({ message: "Receipt not found or already settled" });
    }

    const io = req.app.get("io");

    if (Number(ResultCode) === 0) {
      const items = CallbackMetadata?.Item || [];
      const receiptNumberItem = items.find((i) => i.Name === "MpesaReceiptNumber");
      const mpesaReceiptNumber = receiptNumberItem?.Value || null;

      if (receipt.mpesaSource === "wallet") {
        await finalizeWalletMpesaSuccess({ receipt, mpesaReceiptNumber, io });
      } else {
        await finalizeMpesaSuccess({ receipt, mpesaReceiptNumber, io });
      }
    } else {
      await finalizeMpesaFailure({ receipt, resultDesc: ResultDesc, io });
    }

    res.status(200).json({ message: "Callback processed" });
  } catch (error) {
    console.error("M-Pesa callback error:", error.message);
    res.status(200).json({ message: "Callback error logged" });
  }
};

// @desc    Poll payment status. Also actively queries Daraja, so payment
//          still completes even if the callback URL can't be reached.
// @route   GET /api/receipts/:id/mpesa/status
// @access  Protected — admin
export const getMpesaStatus = async (req, res) => {
  try {
    const receipt = await Receipt.findById(req.params.id);
    if (!receipt) return res.status(404).json({ message: "Receipt not found" });

    if (receipt.status === "paid") {
      return res.json({ status: "success", receipt });
    }
    if (receipt.mpesaStatus !== "pending" || !receipt.mpesaCheckoutRequestId) {
      return res.json({ status: receipt.mpesaStatus || "idle", receipt });
    }

    const io = req.app.get("io");

    try {
      const queryRes = await stkQuery(receipt.mpesaCheckoutRequestId);
      const resultCode = Number(queryRes.ResultCode);

      if (resultCode === 0) {
        if (receipt.mpesaSource === "wallet") {
          await finalizeWalletMpesaSuccess({ receipt, mpesaReceiptNumber: null, io });
        } else {
          await finalizeMpesaSuccess({ receipt, mpesaReceiptNumber: null, io });
        }
        return res.json({ status: "success", receipt });
      }
      if (!isNaN(resultCode)) {
        await finalizeMpesaFailure({ receipt, resultDesc: queryRes.ResultDesc, io });
        return res.json({ status: "failed", message: queryRes.ResultDesc, receipt });
      }
    } catch (queryErr) {
      console.warn("M-Pesa status query still pending:", queryErr.response?.data || queryErr.message);
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
export const cancelMpesaPayment = async (req, res) => {
  try {
    const receipt = await Receipt.findById(req.params.id);
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

  try {
    const receipt = await Receipt.findById(id);
    if (!receipt) return res.status(404).json({ message: "Receipt not found" });
    if (req.shift && !receipt.shift) receipt.shift = req.shift._id;
    if (!["unpaid", "partial"].includes(receipt.status)) {
      return res.status(400).json({ message: "Receipt is already paid or voided" });
    }

    const owed = receipt.totalDue ?? receipt.subtotal;                    // ← added
    const balanceDue = Number((owed - (receipt.amountPaid || 0)).toFixed(2)); // ← changed
    cashAmount = parseFloat(cashAmount);

    if (isNaN(cashAmount) || cashAmount <= 0) {
      return res.status(400).json({ message: "Cash amount must be more than 0" });
    }
    if (cashAmount >= balanceDue) {
      return res.status(400).json({
        message: "Cash amount covers the full balance — use Cash payment instead",
      });
    }

    const tillAmount = Number((balanceDue - cashAmount).toFixed(2));

    receipt.status = "paid";
    receipt.paymentMethod = "both";
    receipt.cashAmount = (receipt.cashAmount || 0) + cashAmount;
    receipt.tillAmount = (receipt.tillAmount || 0) + tillAmount;
    receipt.amountPaid = owed;                                            // ← changed
    receipt.changeGiven = 0;
    receipt.paidAt = new Date();
    receipt.mpesaStatus = receipt.mpesaStatus === "pending" ? "idle" : receipt.mpesaStatus;
    receipt.payments.push(
      { amount: cashAmount, method: "cash", paidBy: req.user?._id || null, paidAt: new Date() },
      { amount: tillAmount, method: "manual_till", paidBy: req.user?._id || null, paidAt: new Date() }
    );

    // Cashback on the full balance just settled (cash + till combined).
    await creditCashback(receipt, cashAmount + tillAmount);

    await receipt.save();

    await Order.findByIdAndUpdate(receipt.order, { status: "completed" });

    const io = req.app.get("io");
    io.emit("receipt:paid", receipt);

    res.json({ message: "Payment successful", receipt });
  } catch (error) {
    console.error("Error processing cash+till payment:", error.message);
    res.status(500).json({ message: "Failed to process payment", error: error.message });
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

  try {
    const receipt = await Receipt.findById(id);
    if (!receipt) return res.status(404).json({ message: "Receipt not found" });
    if (!["unpaid", "partial"].includes(receipt.status)) {
      return res.status(400).json({ message: "Receipt is already paid or voided" });
    }
    if (req.shift && !receipt.shift) receipt.shift = req.shift._id;

    const owed = receipt.totalDue ?? receipt.subtotal;
    const balanceBefore = Number((owed - (receipt.amountPaid || 0)).toFixed(2));
    if (cashAmount + tillAmount + rewardAmount - balanceBefore > 0.01) {
      return res.status(400).json({ message: "Combined amount cannot exceed the balance due" });
    }

    const io = req.app.get("io");

    // ---- Reward leg first — needs the customer's own points balance ----
    if (rewardAmount > 0) {
      if (!rewardIdentifier || !rewardIdentifier.trim()) {
        return res.status(400).json({ message: "Customer email or phone is required to redeem reward points" });
      }
      const customer = await findCustomerByIdentifier(rewardIdentifier);
      if (!customer) {
        return res.status(404).json({ message: "No registered customer found with that email or phone" });
      }
      const settings = await AdminSettings.getSettings();
      const pointValue = settings.reward.pointValueKes || 1;
      const pointsToRedeem = Math.ceil(rewardAmount / pointValue);
      if (pointsToRedeem > (customer.walletPoints || 0)) {
        return res.status(400).json({
          message: `${customer.fullName} only has ${customer.walletPoints} points available`,
        });
      }
      await applyRewardRedemption({ receipt, user: customer, pointsToRedeem, io });
      // applyRewardRedemption already saved the receipt — keep working off
      // the same in-memory doc, it's up to date.
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
      await Order.findByIdAndUpdate(receipt.order, { status: "completed" });
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

import mongoose from "mongoose";
import Receipt from "../models/Receipt.js";
import Order from "../models/Order.js";
import MpesaPaymentAttempt from "../models/MpesaPaymentAttempt.js";
import { creditCashback } from "./walletPayments.js";

const clearActiveAttempt = (receipt, attemptId) => {
  if (String(receipt.mpesaActiveAttempt) === String(attemptId)) {
    receipt.mpesaActiveAttempt = null;
  }
};

export const claimMpesaAttempt = async (checkoutRequestId) =>
  MpesaPaymentAttempt.findOneAndUpdate(
    {
      checkoutRequestId,
      status: { $in: ["pending", "cancelled"] },
      _bypassTenantGuard: true,
    },
    {
      $set: {
        status: "processing",
        processingStartedAt: new Date(),
      },
    },
    { new: true }
  );

export const releaseMpesaAttemptClaim = async (attemptId) => {
  await MpesaPaymentAttempt.updateOne(
    {
      _id: attemptId,
      status: "processing",
      _bypassTenantGuard: true,
    },
    {
      $set: {
        status: "pending",
        processingStartedAt: null,
      },
    }
  );
};

export const settleMpesaAttempt = async ({
  attemptId,
  resultCode,
  resultDesc,
  mpesaReceiptNumber = null,
  io,
}) => {
  const session = await mongoose.startSession();

  try {
    let outcome;

    await session.withTransaction(async () => {
      const attempt = await MpesaPaymentAttempt.findOne({
        _id: attemptId,
        _bypassTenantGuard: true,
      }).session(session);

      if (!attempt || attempt.status !== "processing") {
        outcome = { status: "ignored" };
        return;
      }

      const receipt = await Receipt.findOne({
        _id: attempt.receiptId,
        businessId: attempt.businessId,
        _bypassTenantGuard: true,
      }).session(session);

      if (!receipt) {
        attempt.status = "succeeded-unapplied";
        attempt.resultCode = Number(resultCode);
        attempt.resultDesc = "Receipt no longer exists";
        attempt.mpesaReceiptNumber = mpesaReceiptNumber;
        attempt.processingStartedAt = null;
        attempt.resolvedAt = new Date();
        await attempt.save({ session });

        outcome = { status: "succeeded-unapplied" };
        return;
      }

      // Failed/cancelled STK result. Keep a durable historical attempt,
      // but unblock the receipt only when this was its active attempt.
      if (Number(resultCode) !== 0) {
        attempt.status = "failed";
        attempt.resultCode = Number(resultCode);
        attempt.resultDesc = resultDesc || "Payment was not completed";
        attempt.processingStartedAt = null;
        attempt.resolvedAt = new Date();
        await attempt.save({ session });

        if (String(receipt.mpesaActiveAttempt) === String(attempt._id)) {
          receipt.mpesaStatus = "failed";
          receipt.mpesaResultDesc = attempt.resultDesc;
          receipt.mpesaCheckoutRequestId = attempt.checkoutRequestId;
          clearActiveAttempt(receipt, attempt._id);
          await receipt.save({ session });
        }

        outcome = {
          status: "failed",
          receipt,
          attempt,
        };

        return;
      }

      // A late success after a different payment has already settled the bill
      // must never silently add a duplicate payment. Preserve it for manual
      // reconciliation instead.
      if (receipt.status === "paid" || receipt.status === "voided") {
        attempt.status = "succeeded-unapplied";
        attempt.resultCode = 0;
        attempt.resultDesc =
          "M-Pesa succeeded, but receipt was already settled or voided";
        attempt.mpesaReceiptNumber = mpesaReceiptNumber;
        attempt.processingStartedAt = null;
        attempt.resolvedAt = new Date();
        await attempt.save({ session });

        outcome = {
          status: "succeeded-unapplied",
          receipt,
          attempt,
        };

        return;
      }

      const owed = receipt.totalDue ?? receipt.subtotal;
      const currentPaid = receipt.amountPaid || 0;
      const remaining = Number((owed - currentPaid).toFixed(2));
      const amountToApply = Number(attempt.amount.toFixed(2));
      const cashAmount = Number((attempt.cashAmount || 0).toFixed(2));
      const totalToApply = Number((amountToApply + cashAmount).toFixed(2));

      // A changed receipt must not cause a delayed attempt to overpay it.
      if (totalToApply > remaining) {
        attempt.status = "succeeded-unapplied";
        attempt.resultCode = 0;
        attempt.resultDesc =
          "M-Pesa succeeded, but the receipt balance changed before settlement";
        attempt.mpesaReceiptNumber = mpesaReceiptNumber;
        attempt.processingStartedAt = null;
        attempt.resolvedAt = new Date();
        await attempt.save({ session });

        outcome = {
          status: "succeeded-unapplied",
          receipt,
          attempt,
        };

        return;
      }

      if (cashAmount > 0) {
        receipt.cashAmount = Number(
          ((receipt.cashAmount || 0) + cashAmount).toFixed(2)
        );

        receipt.payments.push({
          amount: cashAmount,
          method: "cash",
          paidBy: attempt.paidBy || null,
          paidAt: new Date(),
        });
      }

      receipt.tillAmount = Number(
        ((receipt.tillAmount || 0) + amountToApply).toFixed(2)
      );

      receipt.payments.push({
        amount: amountToApply,
        method: attempt.source === "wallet" ? "mpesa_stk" : "mpesa_till",
        reference: mpesaReceiptNumber,
        paidBy: attempt.paidBy || null,
        paidAt: new Date(),
      });

      receipt.amountPaid = Number(
        (currentPaid + totalToApply).toFixed(2)
      );

      receipt.status =
        receipt.amountPaid >= owed ? "paid" : "partial";

      receipt.paymentMethod =
        receipt.payments.length > 1
          ? "both"
          : attempt.source === "wallet"
            ? "mpesa_stk"
            : "mpesa_till";

      if (receipt.status === "paid") {
        receipt.paidAt = new Date();
      }

      receipt.mpesaStatus = "success";
      receipt.mpesaCheckoutRequestId = attempt.checkoutRequestId;
      receipt.mpesaMerchantRequestId = attempt.merchantRequestId;
      receipt.mpesaReceiptNumber = mpesaReceiptNumber;
      receipt.mpesaResultDesc = "Payment received successfully";

      clearActiveAttempt(receipt, attempt._id);

      await creditCashback(receipt, totalToApply, session);
      await receipt.save({ session });

      if (receipt.status === "paid") {
        await Order.findOneAndUpdate(
          {
            _id: receipt.order,
            businessId: receipt.businessId,
          },
          {
            status: "completed",
          },
          { session }
        );
      }

      attempt.status = "succeeded";
      attempt.resultCode = 0;
      attempt.resultDesc = resultDesc || "Payment received successfully";
      attempt.mpesaReceiptNumber = mpesaReceiptNumber;
      attempt.processingStartedAt = null;
      attempt.resolvedAt = new Date();
      await attempt.save({ session });

      outcome = {
        status: "success",
        receipt,
        attempt,
      };
    });

    if (outcome?.status === "success") {
      io?.emit("receipt:updated", outcome.receipt);

      if (outcome.receipt.status === "paid") {
        io?.emit("receipt:paid", outcome.receipt);
      }

      io?.emit("mpesa:result", {
        checkoutRequestId: outcome.attempt.checkoutRequestId,
        status: "success",
        receipt: outcome.receipt,
      });
    }

    if (outcome?.status === "failed") {
      io?.emit("mpesa:result", {
        checkoutRequestId: outcome.attempt.checkoutRequestId,
        status: "failed",
        message: outcome.attempt.resultDesc,
      });
    }

    return outcome;
  } finally {
    await session.endSession();
  }
};
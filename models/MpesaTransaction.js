// models/MpesaTransaction.js
import mongoose from "mongoose";
import tenantGuard from "../Middlewares/plugins/tenantGuard.js";

const mpesaTransactionSchema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Business",
      required: true,
    },

    // The receipt this payment is settling. Not required at creation time —
    // an STK push can be initiated before a receipt exists in some flows —
    // but should be backfilled as soon as it's known.
    receiptId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Receipt",
    },

    // Safaricom's two identifiers for a single STK push attempt.
    // checkoutRequestId is the one their callback uses to tell you which
    // transaction it's reporting on — that's the field you'll match on.
    merchantRequestId: { type: String, required: true },
    checkoutRequestId: { type: String, required: true, unique: true },

    phoneNumber: { type: String, required: true, trim: true },

    amount: { type: Number, required: true, min: 0 },

    // pending: STK push sent, awaiting callback
    // success: callback confirmed payment
    // failed: callback reported a failure (insufficient funds, wrong PIN, etc.)
    // cancelled: user cancelled the prompt on their phone
    // timeout: no callback received within the expected window
    status: {
      type: String,
      enum: ["pending", "success", "failed", "cancelled", "timeout"],
      default: "pending",
    },

    // Only present once Safaricom confirms — this is the actual M-Pesa
    // receipt code (e.g. "QGH7XXXX"), distinct from your own receiptId.
    mpesaReceiptNumber: { type: String },

    completedAt: { type: Date },
  },
  {
    // createdAt only — no updatedAt. This is a transaction ledger, not a
    // mutable record; "when did this row last change" isn't meaningful
    // once status transitions are tracked by completedAt.
    timestamps: { createdAt: true, updatedAt: false },
  }
);

// Fast lookup for the callback handler: Safaricom calls back with
// checkoutRequestId, and that's already unique-indexed above.

// Fast lookup for "does this business have any pending payments" / history views.
mpesaTransactionSchema.index({ businessId: 1, status: 1, createdAt: -1 });

// Fast lookup for "what payment(s) belong to this receipt".
mpesaTransactionSchema.index({ businessId: 1, receiptId: 1 });

mpesaTransactionSchema.plugin(tenantGuard);

// Instance helper — the one sanctioned way to mark a transaction settled,
// so callers can't set status: "success" without also stamping completedAt.
mpesaTransactionSchema.methods.markCompleted = function (status, mpesaReceiptNumber) {
  this.status = status;
  this.completedAt = new Date();
  if (mpesaReceiptNumber) this.mpesaReceiptNumber = mpesaReceiptNumber;
  return this.save();
};

export default mongoose.model("MpesaTransaction", mpesaTransactionSchema);
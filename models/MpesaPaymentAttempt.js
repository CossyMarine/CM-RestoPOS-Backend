import mongoose from "mongoose";
import tenantGuard from "../Middlewares/plugins/tenantGuard.js";

const mpesaPaymentAttemptSchema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Business",
      required: true,
      index: true,
    },

    receiptId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Receipt",
      required: true,
      index: true,
    },

    source: {
      type: String,
      enum: ["staff", "wallet"],
      required: true,
    },

    phone: {
      type: String,
      required: true,
    },

    amount: {
      type: Number,
      required: true,
      min: 1,
    },

    cashAmount: {
      type: Number,
      default: 0,
      min: 0,
    },

    paidBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    // This row is created before calling Daraja. If the STK request times
    // out after reaching Daraja, the ambiguous request is preserved instead
    // of being silently forgotten or retried into a second phone prompt.
    status: {
      type: String,
      enum: [
        "initiating",
        "pending",
        "processing",
        "succeeded",
        "succeeded-unapplied",
        "failed",
        "cancelled",
        "unknown",
      ],
      default: "initiating",
      index: true,
    },

    checkoutRequestId: {
      type: String,
      default: null,
    },

    merchantRequestId: {
      type: String,
      default: null,
    },

    mpesaReceiptNumber: {
      type: String,
      default: null,
    },

    resultCode: {
      type: Number,
      default: null,
    },

    resultDesc: {
      type: String,
      default: null,
    },

    initiationError: {
      type: String,
      default: null,
    },

    initiatedAt: {
      type: Date,
      default: null,
    },

    processingStartedAt: {
      type: Date,
      default: null,
    },

    resolvedAt: {
      type: Date,
      default: null,
    },

    cancelledAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

// Daraja checkout IDs must map to exactly one payment attempt system-wide.
mpesaPaymentAttemptSchema.index(
  { checkoutRequestId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      checkoutRequestId: { $type: "string" },
    },
  }
);

// Useful for reconciliation of an individual bill's unresolved attempts.
mpesaPaymentAttemptSchema.index({
  businessId: 1,
  receiptId: 1,
  status: 1,
  createdAt: -1,
});

mpesaPaymentAttemptSchema.plugin(tenantGuard);

export default mongoose.model(
  "MpesaPaymentAttempt",
  mpesaPaymentAttemptSchema
);
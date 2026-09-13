import mongoose from "mongoose";
import tenantGuard from "../Middlewares/plugins/tenantGuard.js";

const etimsSubmissionSchema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Business",
      required: true,
    },
    receiptId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Receipt",
      required: true,
    },

    status: {
      type: String,
      enum: ["queued", "processing", "submitted", "failed", "failed-permanent"],
      default: "queued",
    },

    etimsInvoiceNumber: {
      type: String,
      default: null,
    },

    attempts: {
      type: Number,
      default: 0,
    },

    lastError: {
      type: String,
      default: null,
    },

    processingStartedAt: {
      type: Date,
      default: null,
    },

    submittedAt: {
      type: Date,
      default: null,
    },    // Internally-assigned eTIMS invoice number/sequence — allocated ONCE
    // per submission, on its first processing attempt, and persisted
    // immediately so every retry of THIS submission reuses it instead of
    // consuming a new value. Deliberately separate from etimsInvoiceNumber
    // above: that field is the PROVIDER's own confirmation code, returned
    // AFTER a successful transmission. These are two different numbers
    // with two different origins — one we assign outgoing, one we receive
    // back. assignedInvoiceSequence is the raw counter value (for
    // ordering/auditing); assignedInvoiceNumber is its display form.
    assignedInvoiceSequence: {
      type: Number,
      default: null,
    },
    assignedInvoiceNumber: {
      type: String,
      default: null,
    },
  },
  { timestamps: true }
);

etimsSubmissionSchema.index(
  { businessId: 1, receiptId: 1 },
  { unique: true }
);

etimsSubmissionSchema.index({ businessId: 1, status: 1 });

etimsSubmissionSchema.plugin(tenantGuard);

export default mongoose.model("EtimsSubmission", etimsSubmissionSchema);
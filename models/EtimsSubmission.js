// models/EtimsSubmission.js
import mongoose from "mongoose";
import tenantGuard from "../Middlewares/plugins/tenantGuard.js";

const etimsSubmissionSchema = new mongoose.Schema(
  {
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: "Business", required: true },
    receiptId: { type: mongoose.Schema.Types.ObjectId, ref: "Receipt", required: true },

    status: {
      type: String,
      enum: ["queued", "submitted", "failed", "failed-permanent"],
      default: "queued",
    },

    // eTIMS's own confirmation code once accepted — the fiscal receipt
    // number, distinct from your own receiptId.
    etimsInvoiceNumber: { type: String, default: null },

    attempts: { type: Number, default: 0 },
    lastError: { type: String, default: null },
    submittedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

etimsSubmissionSchema.index({ businessId: 1, receiptId: 1 }, { unique: true });
etimsSubmissionSchema.index({ businessId: 1, status: 1 });
etimsSubmissionSchema.plugin(tenantGuard);

export default mongoose.model("EtimsSubmission", etimsSubmissionSchema);
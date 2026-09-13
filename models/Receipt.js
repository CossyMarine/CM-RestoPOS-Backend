// models/Receipt.js
import mongoose from "mongoose";
import { orderItemSchema } from "./Order.js";
import tenantGuard from "../Middlewares/plugins/tenantGuard.js";
import { queueEtimsSubmission } from "../jobs/etimsJob.js";

// One entry per payment towards a bill — supports partial payments,
// multiple methods on the same bill, and a full audit trail.
const paymentEntrySchema = new mongoose.Schema(
  {
    amount: { type: Number, required: true },
    method: {
      type: String,
      enum: [
        "cash",
        "mpesa_till",
        "mpesa_paybill",
        "mpesa_pochi",
        "mpesa_stk",
        "manual_till",
        "reward",
        "both",
      ],
      required: true,
    },
    reference: { type: String, default: null },
    paidBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    paidAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const receiptSchema = new mongoose.Schema(
  {
    billId: {
      type: String,
      required: true,
    },
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Business",
      required: true,
      index: true,
    },

    order: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      required: true,
    },

    shift: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Shift",
      default: null,
    },

    tableNumber: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
    },

    waiterName: {
      type: String,
      default: null,
    },

    source: {
      type: String,
      enum: ["staff", "online"],
      default: "staff",
    },

    items: [orderItemSchema],

    subtotal: {
      type: Number,
      required: true,
    },
    discount: {
      type: {
        kind: { type: String, enum: ["percent", "fixed", null], default: null },
        value: { type: Number, default: 0 },
        amount: { type: Number, default: 0 },
        reason: { type: String, default: null },
        appliedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
      },
      default: () => ({}),
    },

    tax: {
      type: {
        ratePercent: { type: Number, default: 0 },
        inclusive: { type: Boolean, default: true },
        amount: { type: Number, default: 0 },
      },
      default: () => ({}),
    },

    totalDue: { type: Number, default: null },

    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    status: {
      type: String,
      enum: ["unpaid", "partial", "paid", "voided"],
      default: "unpaid",
    },

    paymentMethod: {
      type: String,
      enum: [
        "cash",
        "mpesa_till",
        "mpesa_paybill",
        "mpesa_pochi",
        "mpesa_stk",
        "manual_till",
        "reward",
        "both",
        null,
      ],
      default: null,
    },

    amountPaid: {
      type: Number,
      default: null,
    },

    changeGiven: {
      type: Number,
      default: null,
    },

    cashAmount: {
      type: Number,
      default: 0,
    },

    tillAmount: {
      type: Number,
      default: 0,
    },

    payments: [paymentEntrySchema],

    rewardPointsEarned: {
      type: Number,
      default: 0,
    },

    rewardPointsRedeemed: {
      type: Number,
      default: 0,
    },

    rewardKesRedeemed: {
      type: Number,
      default: 0,
    },

    // ---- M-Pesa Daraja STK Push tracking ----
    mpesaSource: {
      type: String,
      enum: ["staff", "wallet", null],
      default: null,
    },

    mpesaPhone: {
      type: String,
      default: null,
    },

    mpesaCheckoutRequestId: {
      type: String,
      default: null,
      index: true,
    },

    mpesaMerchantRequestId: {
      type: String,
      default: null,
    },

    mpesaReceiptNumber: {
      type: String,
      default: null,
    },

    mpesaResultDesc: {
      type: String,
      default: null,
    },

    // FIXED — "processing" added. This is the atomic-claim state used by
    // the idempotent M-Pesa callback/poll/sweep logic from Phase 3; without
    // it in the enum, any attempt to set this value throws a Mongoose
    // validation error.
    mpesaStatus: {
      type: String,
      enum: ["idle", "initiating", "pending", "processing", "success", "failed"],
      default: "idle",
    },

    pendingCashAmount: {
      type: Number,
      default: 0,
    },

    pendingTillAmount: {
      type: Number,
      default: 0,
    },

    pendingPaidBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    pendingManualPayments: [
      {
        amount: {
          type: Number,
          required: true,
        },
        reference: {
          type: String,
          required: true,
        },
        paidBy: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
          default: null,
        },
        paidByName: {
          type: String,
          default: null,
        },
        submittedAt: {
          type: Date,
          default: Date.now,
        },
      },
    ],

    voidReason: {
      type: String,
      default: null,
    },

    printedAt: {
      type: Date,
      default: null,
    },

    paidAt: {
      type: Date,
      default: null,
    },

    printCount: {
      type: Number,
      default: 0,
    },
 mpesaActiveAttempt: {
  type: mongoose.Schema.Types.ObjectId,
  ref: "MpesaPaymentAttempt",
  default: null,
},
    mpesaInitiatedAt: { type: Date }, // when the STK push was actually sent — used for timeout detection
  },
 
  {
    timestamps: true,
  }
);

receiptSchema.pre("save", function (next) {
  this._justBecamePaid = this.isModified("status") && this.status === "paid";
  next();
});

receiptSchema.post("save", function (doc) {
  if (doc._justBecamePaid) {
    queueEtimsSubmission(doc); // fire-and-forget — not awaited, never blocks the response
  }
});

receiptSchema.index({ businessId: 1, billId: 1 }, { unique: true });
receiptSchema.index({ businessId: 1, order: 1 }, { unique: true });
receiptSchema.index({ businessId: 1, status: 1, createdAt: -1 });
receiptSchema.index({ businessId: 1, status: 1, paidAt: -1 });
receiptSchema.index({ businessId: 1, waiterName: 1, createdAt: -1 });
receiptSchema.index({ businessId: 1, source: 1, waiterName: 1, createdAt: 1 });
receiptSchema.plugin(tenantGuard);

export default mongoose.model("Receipt", receiptSchema);
export { orderItemSchema };
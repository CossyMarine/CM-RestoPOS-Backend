// models/Receipt.js
import mongoose from "mongoose";
import { orderItemSchema } from "./Order.js";

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
    // M-Pesa code, payer's full name (manual till), or a reward note
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
      unique: true,
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

    // NEW: Indicates where the order originated
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

    // The registered customer this bill belongs to (null for walk-in/guest bills)
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

    // "both" = split cash + till payment. Reflects the most recent/primary
    // method — full breakdown lives in `payments`.
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

    // Running total received across all payments
    amountPaid: {
      type: Number,
      default: null,
    },

    changeGiven: {
      type: Number,
      default: null,
    },

    // Split breakdown for the classic staff cash/till flow
    cashAmount: {
      type: Number,
      default: 0,
    },

    tillAmount: {
      type: Number,
      default: 0,
    },

    // Full payment history
    payments: [paymentEntrySchema],

    // ---- Reward / cashback tracking ----
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
    // "staff" = waiter/admin initiated
    // "wallet" = customer initiated
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

    mpesaStatus: {
      type: String,
      enum: ["idle", "pending", "success", "failed"],
      default: "idle",
    },

    // Held while an STK push is in flight
    pendingCashAmount: {
      type: Number,
      default: 0,
    },

    pendingTillAmount: {
      type: Number,
      default: 0,
    },

    // Who initiated the wallet payment
    pendingPaidBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    // ---- Customer manual till payment claims ----
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
  },
  {
    timestamps: true,
  }
);

export default mongoose.model("Receipt", receiptSchema);
export { orderItemSchema };

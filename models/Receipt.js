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
    paidBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    paidAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const receiptSchema = new mongoose.Schema(
  {
    billId: { type: String, required: true, unique: true },
    order:  { type: mongoose.Schema.Types.ObjectId, ref: "Order", required: true },
    shift:  { type: mongoose.Schema.Types.ObjectId, ref: "Shift", default: null },

    tableNumber: { type: mongoose.Schema.Types.Mixed, required: true },
    waiterName:  { type: String, default: null },
    items:       [orderItemSchema],
    subtotal:    { type: Number, required: true },

    // The registered customer this bill belongs to (null for walk-in/guest bills)
    customer: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },

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
    amountPaid:  { type: Number, default: null }, // running total received, across all payments
    changeGiven: { type: Number, default: null },

    // Split breakdown for the classic staff cash/till flow
    cashAmount: { type: Number, default: 0 },
    tillAmount: { type: Number, default: 0 },

    // Full payment history — supports partial payments and mixed methods
    payments: [paymentEntrySchema],

    // ---- Reward / cashback tracking for this bill ----
    rewardPointsEarned:   { type: Number, default: 0 }, // cashback points this bill generated
    rewardPointsRedeemed: { type: Number, default: 0 }, // points spent against this bill
    rewardKesRedeemed:    { type: Number, default: 0 }, // KES value of points spent

    // ---- M-Pesa Daraja STK Push tracking ----
    // "staff" = waiter/admin-initiated (existing flow), "wallet" = customer-initiated
    mpesaSource: { type: String, enum: ["staff", "wallet", null], default: null },
    mpesaPhone:             { type: String, default: null },
    mpesaCheckoutRequestId: { type: String, default: null, index: true },
    mpesaMerchantRequestId: { type: String, default: null },
    mpesaReceiptNumber:     { type: String, default: null },
    mpesaResultDesc:        { type: String, default: null },
    mpesaStatus: {
      type: String,
      enum: ["idle", "pending", "success", "failed"],
      default: "idle",
    },
    // Held while an STK push is in flight, applied once Daraja confirms
    pendingCashAmount: { type: Number, default: 0 },
    pendingTillAmount: { type: Number, default: 0 },
    // Who triggered a wallet STK push — needed to credit the payer on the payment record
    pendingPaidBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },

    // ---- Customer self-reported manual till payments awaiting admin confirmation ----
    // A customer paying via the wallet claims they sent money to the till, but this is
    // NOT applied to the bill (status stays unpaid/partial) until an admin confirms it
    // here on the Payments page. Staff-entered till payments (from the Orders ledger)
    // skip this queue entirely and post straight to `payments` — see payWithManualTill.
    pendingManualPayments: [
      {
        amount: { type: Number, required: true },
        reference: { type: String, required: true },
        paidBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
        paidByName: { type: String, default: null },
        submittedAt: { type: Date, default: Date.now },
      },
    ],

    voidReason: { type: String, default: null },
    printedAt:  { type: Date, default: null },
    paidAt:     { type: Date, default: null },
    printCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

export default mongoose.model("Receipt", receiptSchema);
export { orderItemSchema };

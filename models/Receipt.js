// models/Receipt.js
import mongoose from "mongoose";
import { orderItemSchema } from "./Order.js";

const receiptSchema = new mongoose.Schema(
  {
    billId: { type: String, required: true, unique: true },
    order:  { type: mongoose.Schema.Types.ObjectId, ref: "Order", required: true },
    shift:  { type: mongoose.Schema.Types.ObjectId, ref: "Shift", default: null },

    tableNumber: { type: mongoose.Schema.Types.Mixed, required: true },
    waiterName:  { type: String, default: null },
    items:       [orderItemSchema],
    subtotal:    { type: Number, required: true },

    status: {
      type: String,
      enum: ["unpaid", "paid", "voided"],
      default: "unpaid",
    },

    // "both" = split cash + till payment
    paymentMethod: {
      type: String,
      enum: ["cash", "mpesa_till", "mpesa_paybill", "mpesa_pochi", "both", null],
      default: null,
    },
    amountPaid:  { type: Number, default: null }, // total received (cash + till)
    changeGiven: { type: Number, default: null },

    // Split breakdown — populated for every completed payment going forward
    cashAmount: { type: Number, default: 0 },
    tillAmount: { type: Number, default: 0 },

    // ---- M-Pesa Daraja STK Push tracking ----
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

    voidReason: { type: String, default: null },
    printedAt:  { type: Date, default: null },
    paidAt:     { type: Date, default: null },
    printCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

export default mongoose.model("Receipt", receiptSchema);

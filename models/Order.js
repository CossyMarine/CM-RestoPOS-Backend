// models/Order.js
import mongoose from "mongoose";

const orderItemSchema = new mongoose.Schema(
  {
    mealName:  { type: String, required: true },
    quantity:  { type: Number, required: true },
    unitPrice: { type: Number, required: true },
    lineTotal: { type: Number, required: true },
  },
  { _id: false }
);

const orderSchema = new mongoose.Schema(
  {
    tableNumber: { type: mongoose.Schema.Types.Mixed, required: true },
    waiterName:  { type: String, default: null },
    items:       [orderItemSchema],
    subtotal:    { type: Number, required: true },
    status: {
      type: String,
      enum: ["pending", "completed", "cancelled"],
      default: "pending",
    },
    source: { type: String, enum: ["staff", "online"], default: "staff" },

    // Registered customer who placed this order (online orders now require login)
    customer: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    customerName: { type: String, default: null },
  },
  { timestamps: true }
);

export default mongoose.model("Order", orderSchema);
export { orderItemSchema };

// models/Order.js
import mongoose from "mongoose";
import tenantGuard from "../Middlewares/plugins/tenantGuard.js";

const orderItemSchema = new mongoose.Schema(
  {
    menuItemId: { type: mongoose.Schema.Types.ObjectId, ref: "MenuItem", default: null },
    mealName:  { type: String, required: true },
    imageUrl:  { type: String, default: null }, // snapshot at order time — survives later menu edits
    quantity:  { type: Number, required: true },
    unitPrice: { type: Number, required: true },
    lineTotal: { type: Number, required: true },
    ready:     { type: Boolean, default: false }, // per-item kitchen check-off
    addedAt:   { type: Date, default: null }, // set when this line was appended to an existing bill after the original order (waiter "Add Items" flow) — null for items placed with the original order
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
      enum: ["pending", "serving", "completed", "cancelled"],
      default: "pending",
    },
    source: { type: String, enum: ["staff", "online"], default: "staff" },
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Business",
      required: true,
      index: true,
    },

    // Registered customer who placed this order (online orders now require login)
    customer: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    customerName: { type: String, default: null },

    // Kitchen timing — set once, on the transition into that status
    servedAt:    { type: Date, default: null }, // when marked completed
    cancelledAt: { type: Date, default: null },
  },
  { timestamps: true }
);
// models/Order.js
orderSchema.index({ businessId: 1, createdAt: -1 });
orderSchema.index({ businessId: 1, status: 1, createdAt: -1 });
orderSchema.index({ businessId: 1, status: 1, servedAt: 1 });
orderSchema.plugin(tenantGuard);
export default mongoose.model("Order", orderSchema);
export { orderItemSchema };

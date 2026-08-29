import mongoose from "mongoose";

const purchaseOrderItemSchema = new mongoose.Schema(
  {
    inventoryItem: { type: mongoose.Schema.Types.ObjectId, ref: "InventoryItem", required: true },
    quantityOrdered: { type: Number, required: true, min: 0.000001 },
    quantityReceived: { type: Number, required: true, default: 0, min: 0 },
    unit: { type: mongoose.Schema.Types.ObjectId, ref: "InventoryUnit", required: true },
    costPerUnit: { type: Number, required: true, min: 0 },
    totalCost: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const purchaseOrderSchema = new mongoose.Schema(
  {
    poNumber: { type: String, required: true, unique: true, trim: true },
    supplier: { type: mongoose.Schema.Types.ObjectId, ref: "Supplier", required: true },
    location: { type: mongoose.Schema.Types.ObjectId, ref: "InventoryLocation", required: true },
    orderedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    items: { type: [purchaseOrderItemSchema], required: true, default: [] },
    note: { type: String, trim: true, default: "" },
    status: {
      type: String,
      enum: ["draft", "ordered", "partially_received", "received", "cancelled"],
      default: "draft",
    },
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Business",
      required: true,
      index: true,
    },
  },
  { timestamps: true }
);

const PurchaseOrder = mongoose.model("PurchaseOrder", purchaseOrderSchema);

export default PurchaseOrder;

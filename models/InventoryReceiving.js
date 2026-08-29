import mongoose from "mongoose";

const receivingItemSchema = new mongoose.Schema(
  {
    inventoryItem: { type: mongoose.Schema.Types.ObjectId, ref: "InventoryItem", required: true },
    quantity: { type: Number, required: true, min: 0.000001 },
    unit: { type: mongoose.Schema.Types.ObjectId, ref: "InventoryUnit", required: true },
    costPerUnit: { type: Number, required: true, min: 0 },
    totalCost: { type: Number, required: true, min: 0 },
    batchNumber: { type: String, trim: true, default: "" },
    manufacturingDate: { type: Date },
    expiryDate: { type: Date },
    batchNote: { type: String, trim: true, default: "" },
    batch: { type: mongoose.Schema.Types.ObjectId, ref: "InventoryBatch" },
  },
  { _id: false }
);

const inventoryReceivingSchema = new mongoose.Schema(
  {
    
    
    supplierName: { type: String, trim: true, default: "" },
    supplier: { type: mongoose.Schema.Types.ObjectId, ref: "Supplier" },
    purchaseOrder: { type: mongoose.Schema.Types.ObjectId, ref: "PurchaseOrder" },
    referenceNumber: { type: String, trim: true, default: "" },
    location: { type: mongoose.Schema.Types.ObjectId, ref: "InventoryLocation", required: true },
    items: { type: [receivingItemSchema], required: true, default: [] },
    receivedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    note: { type: String, trim: true, default: "" },
    status: {
      type: String,
      enum: ["received", "cancelled"],
      default: "received",
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

const InventoryReceiving = mongoose.model("InventoryReceiving", inventoryReceivingSchema);

export default InventoryReceiving;

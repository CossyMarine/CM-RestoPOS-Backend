import mongoose from "mongoose";

const receivingItemSchema = new mongoose.Schema(
  {
    inventoryItem: { type: mongoose.Schema.Types.ObjectId, ref: "InventoryItem", required: true },
    quantity: { type: Number, required: true, min: 0.000001 },
    unit: { type: mongoose.Schema.Types.ObjectId, ref: "InventoryUnit", required: true },
    costPerUnit: { type: Number, required: true, min: 0 },
    totalCost: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const inventoryReceivingSchema = new mongoose.Schema(
  {
    
    
    supplierName: { type: String, trim: true, default: "" },
    supplier: { type: mongoose.Schema.Types.ObjectId, ref: "Supplier" },
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
  },
  { timestamps: true }
);

const InventoryReceiving = mongoose.model("InventoryReceiving", inventoryReceivingSchema);

export default InventoryReceiving;

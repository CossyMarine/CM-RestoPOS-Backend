// models/InventoryTransfer.js
import mongoose from "mongoose";

const inventoryTransferSchema = new mongoose.Schema(
  {
    item: { type: mongoose.Schema.Types.ObjectId, ref: "InventoryItem", required: true },
    quantity: { type: Number, required: true },
    fromLocation: { type: mongoose.Schema.Types.ObjectId, ref: "InventoryLocation", required: true },
    toLocation: { type: mongoose.Schema.Types.ObjectId, ref: "InventoryLocation", required: true },
    transferredBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    note: { type: String, trim: true, default: "" },
  },
  { timestamps: true }
);

const InventoryTransfer = mongoose.model("InventoryTransfer", inventoryTransferSchema);

export default InventoryTransfer;

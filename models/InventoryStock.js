// models/InventoryStock.js
import mongoose from "mongoose";

const inventoryStockSchema = new mongoose.Schema(
  {
    item: { type: mongoose.Schema.Types.ObjectId, ref: "InventoryItem", required: true },
    location: { type: mongoose.Schema.Types.ObjectId, ref: "InventoryLocation", required: true },
    quantity: { type: Number, default: 0 },
  },
  { timestamps: true }
);

inventoryStockSchema.index({ item: 1, location: 1 }, { unique: true });

const InventoryStock = mongoose.model("InventoryStock", inventoryStockSchema);

export default InventoryStock;

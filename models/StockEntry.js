// models/StockEntry.js
import mongoose from "mongoose";

const stockEntrySchema = new mongoose.Schema(
  {
    item:        { type: mongoose.Schema.Types.ObjectId, ref: "InventoryItem", required: true },
    location:    { type: mongoose.Schema.Types.ObjectId, ref: "InventoryLocation" },
    batch:       { type: mongoose.Schema.Types.ObjectId, ref: "InventoryBatch" },
    quantity:    { type: Number, required: true },     // amount added, in the item's unit
    costPerUnit: { type: Number, required: true },     // purchase price at the time of this entry
    totalCost:   { type: Number, required: true },     // quantity * costPerUnit, snapshotted
    addedBy:     { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    note:        { type: String, default: "" },
  },
  { timestamps: true }
);

export default mongoose.model("StockEntry", stockEntrySchema);

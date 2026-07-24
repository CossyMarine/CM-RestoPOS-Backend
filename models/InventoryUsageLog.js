// models/InventoryUsageLog.js
import mongoose from "mongoose";

const inventoryUsageLogSchema = new mongoose.Schema(
  {
    item:        { type: mongoose.Schema.Types.ObjectId, ref: "InventoryItem", required: true },
    // "used"/"waste": quantity is the positive amount removed.
    // "adjustment": quantity is a signed delta applied directly (admin stock corrections).
    quantity:    { type: Number, required: true },
    reason:      { type: String, enum: ["used", "waste", "adjustment"], default: "used" },
    costPerUnit: { type: Number, required: true }, // snapshot of item.costPerUnit at log time
    totalValue:  { type: Number, required: true }, // quantity * costPerUnit, snapshotted
    recordedBy:  { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    note:        { type: String, default: "" },
  },
  { timestamps: true }
);

export default mongoose.model("InventoryUsageLog", inventoryUsageLogSchema);

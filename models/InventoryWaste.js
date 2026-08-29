import mongoose from "mongoose";
import tenantGuard from "../Middlewares/plugins/tenantGuard.js";

const inventoryWasteSchema = new mongoose.Schema(
  {
    item: { type: mongoose.Schema.Types.ObjectId, ref: "InventoryItem", required: true },
    location: { type: mongoose.Schema.Types.ObjectId, ref: "InventoryLocation", required: true },
    batch: { type: mongoose.Schema.Types.ObjectId, ref: "InventoryBatch" },
    batchUsage: [{
      batch: { type: mongoose.Schema.Types.ObjectId, ref: "InventoryBatch", required: true },
      quantityConsumed: { type: Number, required: true, min: 0.000001 },
    }],
    legacyQuantityConsumed: { type: Number, default: 0, min: 0 },
    quantity: { type: Number, required: true },
    unit: { type: mongoose.Schema.Types.ObjectId, ref: "InventoryUnit", required: true },
    reason: {
      type: String,
      enum: ["damaged", "spoiled", "expired", "spillage", "other"],
      required: true,
    },
    costPerUnit: { type: Number, required: true },
    totalValue: { type: Number, required: true },
    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    note: { type: String, default: "" },
    status: { type: String, enum: ["recorded", "cancelled"], default: "recorded" },
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Business",
      required: true,
      index: true,
    },
  },
  { timestamps: true }
);

export default mongoose.model("InventoryWaste", inventoryWasteSchema);

import mongoose from "mongoose";
import tenantGuard from "../Middlewares/plugins/tenantGuard.js";

const inventoryBatchSchema = new mongoose.Schema(
  {
    batchNumber: { type: String, required: true, trim: true },
    inventoryItem: { type: mongoose.Schema.Types.ObjectId, ref: "InventoryItem", required: true },
    location: { type: mongoose.Schema.Types.ObjectId, ref: "InventoryLocation", required: true },
    quantity: { type: Number, required: true, default: 0 },
    unit: { type: mongoose.Schema.Types.ObjectId, ref: "InventoryUnit", required: true },
    costPerUnit: { type: Number, required: true, default: 0 },
    manufacturingDate: { type: Date },
    expiryDate: { type: Date },
    supplier: { type: mongoose.Schema.Types.ObjectId, ref: "Supplier" },
    receiving: { type: mongoose.Schema.Types.ObjectId, ref: "InventoryReceiving" },
    production: { type: mongoose.Schema.Types.ObjectId, ref: "Production" },
    waste: { type: mongoose.Schema.Types.ObjectId, ref: "InventoryWaste" },
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Business",
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ["active", "depleted", "expired", "cancelled"],
      default: "active",
    },
    note: { type: String, default: "", trim: true },
  },
  { timestamps: true }
);

// A physical lot can exist at more than one location after a stock transfer.
inventoryBatchSchema.index({ batchNumber: 1, inventoryItem: 1, location: 1 }, { unique: true });
inventoryBatchSchema.index({ businessId: 1, inventoryItem: 1, location: 1, status: 1, expiryDate: 1, createdAt: 1 });
inventoryBatchSchema.plugin(tenantGuard);
const InventoryBatch = mongoose.model("InventoryBatch", inventoryBatchSchema);

export default InventoryBatch;

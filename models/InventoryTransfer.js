// models/InventoryTransfer.js
import mongoose from "mongoose";
import tenantGuard from "../Middlewares/plugins/tenantGuard.js";

const inventoryTransferSchema = new mongoose.Schema(
  {businessId: {
  type: mongoose.Schema.Types.ObjectId,
  ref: "Business",
  required: true,
  index: true,
},
    item: { type: mongoose.Schema.Types.ObjectId, ref: "InventoryItem", required: true },
    quantity: { type: Number, required: true },
    fromLocation: { type: mongoose.Schema.Types.ObjectId, ref: "InventoryLocation", required: true },
    toLocation: { type: mongoose.Schema.Types.ObjectId, ref: "InventoryLocation", required: true },
    transferredBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    batchTransfers: [{
      batch: { type: mongoose.Schema.Types.ObjectId, ref: "InventoryBatch", required: true },
      quantity: { type: Number, required: true, min: 0.000001 },
      destinationBatch: { type: mongoose.Schema.Types.ObjectId, ref: "InventoryBatch" },
    }],
    legacyQuantity: { type: Number, default: 0, min: 0 },
    note: { type: String, trim: true, default: "" },
  },
  { timestamps: true }
);
// models/InventoryTransfer.js
inventoryTransferSchema.index({ businessId: 1, createdAt: -1 });
inventoryTransferSchema.index({ businessId: 1, item: 1, createdAt: -1 });
inventoryTransferSchema.plugin(tenantGuard);

const InventoryTransfer = mongoose.model("InventoryTransfer", inventoryTransferSchema);

export default InventoryTransfer;

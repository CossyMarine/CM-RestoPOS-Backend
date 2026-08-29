// models/InventoryStock.js
import mongoose from "mongoose";
import tenantGuard from "../Middlewares/plugins/tenantGuard.js";

const inventoryStockSchema = new mongoose.Schema(
  {
    item: { type: mongoose.Schema.Types.ObjectId, ref: "InventoryItem", required: true },
    location: { type: mongoose.Schema.Types.ObjectId, ref: "InventoryLocation", required: true },
    quantity: { type: Number, default: 0 },
    // Quantity not represented by a batch. This is the migration-safe pool for
    // stock that existed before batch tracking (and explicit unbatched adjustments).
    // `undefined` is intentionally preserved for records that have not been
    // reconciled yet; controllers initialize it transactionally on first write.
    unbatchedQuantity: { type: Number, default: undefined, min: 0 },
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Business",
      required: true,
      index: true,
    },
  },
  { timestamps: true }
);

inventoryStockSchema.index({ item: 1, location: 1 }, { unique: true });

const InventoryStock = mongoose.model("InventoryStock", inventoryStockSchema);

export default InventoryStock;

// models/InventoryUnit.js
import mongoose from "mongoose";
import tenantGuard from "../Middlewares/plugins/tenantGuard.js";

const inventoryUnitSchema = new mongoose.Schema(
  {
    name:         { type: String, required: true, trim: true },   // e.g. "Kilogram", "Sag", "Korogoro"
    abbreviation: { type: String, required: true, trim: true },   // e.g. "kg", "sag", "kor"
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Business",
      required: true,
      index: true,
    },
  },
  { timestamps: true }
);
inventoryUnitSchema.plugin(tenantGuard);

export default mongoose.model("InventoryUnit", inventoryUnitSchema);














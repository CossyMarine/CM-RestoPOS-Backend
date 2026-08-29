// models/InventoryUnit.js
import mongoose from "mongoose";

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

export default mongoose.model("InventoryUnit", inventoryUnitSchema);














// models/InventoryUnit.js
import mongoose from "mongoose";

const inventoryUnitSchema = new mongoose.Schema(
  {
    name:         { type: String, required: true, trim: true },   // e.g. "Kilogram", "Sag", "Korogoro"
    abbreviation: { type: String, required: true, trim: true },   // e.g. "kg", "sag", "kor"
  },
  { timestamps: true }
);

export default mongoose.model("InventoryUnit", inventoryUnitSchema);

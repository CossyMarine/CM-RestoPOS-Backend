// models/InventoryItem.js
import mongoose from "mongoose";

const inventoryItemSchema = new mongoose.Schema(
  {
    name:         { type: String, required: true, trim: true },
    itemType:     {
      type: String,
      enum: ["raw_material", "finished_product", "consumable", "packaging", "mro"],
      default: "raw_material",
      required: true,
      trim: true,
    },
    unit:         { type: mongoose.Schema.Types.ObjectId, ref: "InventoryUnit", required: true },
    category:     { type: String, default: "General", trim: true }, // admin-defined, free text
    costPerUnit:  { type: Number, default: 0 },   // latest known purchase cost per unit
    currentStock: { type: Number, default: 0 },   // running quantity in stock
    reorderLevel: { type: Number, default: 0 },   // low-stock threshold; 0 = no alert
    isActive:     { type: Boolean, default: true },
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Business",
      required: true,
      index: true,
    },
  },
  { timestamps: true }
);

export default mongoose.model("InventoryItem", inventoryItemSchema);

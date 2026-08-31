// models/Recipe.js
import mongoose from "mongoose";
import tenantGuard from "../Middlewares/plugins/tenantGuard.js";

const ingredientSchema = new mongoose.Schema(
  {
    inventoryItem: { type: mongoose.Schema.Types.ObjectId, ref: "InventoryItem", required: true },
    quantity: { type: Number, required: true, min: 0.000001 },
    unit: { type: mongoose.Schema.Types.ObjectId, ref: "InventoryUnit", required: true },
  },
  { _id: false }
);

const recipeSchema = new mongoose.Schema(
  {
    menuItem: { type: mongoose.Schema.Types.ObjectId, ref: "MenuItem", required: true },
    ingredients: { type: [ingredientSchema], required: true, default: [] },
    isActive: { type: Boolean, default: true },
    note: { type: String, trim: true, default: "" },
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Business",
      required: true,
      index: true,
    },
  },
  { timestamps: true }
);
recipeSchema.index({ businessId: 1, isActive: 1 });
recipeSchema.index({ businessId: 1, menuItem: 1, isActive: 1 }, { unique: true });
recipeSchema.plugin(tenantGuard);

const Recipe = mongoose.model("Recipe", recipeSchema);

export default Recipe;
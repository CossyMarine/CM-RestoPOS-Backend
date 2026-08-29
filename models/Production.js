import mongoose from "mongoose";

const ingredientUsageSchema = new mongoose.Schema(
  {
    inventoryItem: { type: mongoose.Schema.Types.ObjectId, ref: "InventoryItem", required: true },
    quantityUsed: { type: Number, required: true, min: 0.000001 },
    unit: { type: mongoose.Schema.Types.ObjectId, ref: "InventoryUnit", required: true },
    costPerUnit: { type: Number, required: true, default: 0 },
    totalCost: { type: Number, required: true, default: 0 },
    batchUsage: [{
      batch: { type: mongoose.Schema.Types.ObjectId, ref: "InventoryBatch", required: true },
      quantityConsumed: { type: Number, required: true, min: 0.000001 },
    }],
    legacyQuantityConsumed: { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

const productionSchema = new mongoose.Schema(
  {
    producedItem: { type: mongoose.Schema.Types.ObjectId, ref: "InventoryItem", required: true },
    menuItem: { type: mongoose.Schema.Types.ObjectId, ref: "MenuItem" },
    recipe: { type: mongoose.Schema.Types.ObjectId, ref: "Recipe" },
    quantityProduced: { type: Number, required: true, min: 0.000001 },
    unit: { type: mongoose.Schema.Types.ObjectId, ref: "InventoryUnit", required: true },
    location: { type: mongoose.Schema.Types.ObjectId, ref: "InventoryLocation", required: true },
    ingredientsUsed: { type: [ingredientUsageSchema], required: true, default: [] },
    producedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    note: { type: String, default: "", trim: true },
    status: {
      type: String,
      enum: ["draft", "pending", "completed", "cancelled"],
      default: "completed",
    },
    producedBatch: { type: mongoose.Schema.Types.ObjectId, ref: "InventoryBatch" },
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Business",
      required: true,
      index: true,
    },
  },
  { timestamps: true }
);

const Production = mongoose.model("Production", productionSchema);

export default Production;

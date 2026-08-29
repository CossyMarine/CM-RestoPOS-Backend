// models/InventoryLocation.js
import mongoose from "mongoose";
import tenantGuard from "../Middlewares/plugins/tenantGuard.js";

const inventoryLocationSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    code: { type: String, required: true, trim: true, uppercase: true },
    isActive: { type: Boolean, default: true },
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Business",
      required: true,
      index: true,
    },
  },
  { timestamps: true }
);

inventoryLocationSchema.index({ businessId: 1, name: 1 }, { unique: true });
inventoryLocationSchema.index({ businessId: 1, code: 1 }, { unique: true });

inventoryLocationSchema.plugin(tenantGuard);

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const seedDefaultInventoryLocations = async (businessId) => {
  if (!businessId) throw new Error("seedDefaultInventoryLocations requires a businessId");

  const defaults = [
    { name: "Store", code: "STORE" },
    { name: "Kitchen", code: "KITCHEN" },
    { name: "In Transit", code: "IN_TRANSIT" },
  ];

  for (const location of defaults) {
    const normalizedName = location.name.trim();
    const normalizedCode = location.code.trim().toUpperCase();

    const existing = await InventoryLocation.findOne({
      businessId,
      $or: [
        { name: new RegExp(`^${escapeRegExp(normalizedName)}$`, "i") },
        { code: new RegExp(`^${escapeRegExp(normalizedCode)}$`, "i") },
      ],
    });

    if (!existing) {
      await InventoryLocation.create({
        businessId,
        name: normalizedName,
        code: normalizedCode,
        isActive: true,
      });
    }
  }
};

const InventoryLocation = mongoose.model("InventoryLocation", inventoryLocationSchema);

export default InventoryLocation;
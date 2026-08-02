// models/InventoryLocation.js
import mongoose from "mongoose";

const inventoryLocationSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    code: { type: String, required: true, trim: true, uppercase: true },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

inventoryLocationSchema.index({ name: 1 }, { unique: true });
inventoryLocationSchema.index({ code: 1 }, { unique: true });

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const seedDefaultInventoryLocations = async () => {
  const defaults = [
    { name: "Store", code: "STORE" },
    { name: "Kitchen", code: "KITCHEN" },
    { name: "In Transit", code: "IN_TRANSIT" },
  ];

  for (const location of defaults) {
    const normalizedName = location.name.trim();
    const normalizedCode = location.code.trim().toUpperCase();

    const existing = await InventoryLocation.findOne({
      $or: [
        { name: new RegExp(`^${escapeRegExp(normalizedName)}$`, "i") },
        { code: new RegExp(`^${escapeRegExp(normalizedCode)}$`, "i") },
      ],
    });

    if (!existing) {
      await InventoryLocation.create({
        name: normalizedName,
        code: normalizedCode,
        isActive: true,
      });
    }
  }
};

const InventoryLocation = mongoose.model("InventoryLocation", inventoryLocationSchema);

export default InventoryLocation;

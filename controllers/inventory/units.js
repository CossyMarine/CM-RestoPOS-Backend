// controllers/inventory/units.js
import InventoryUnit from "../../models/InventoryUnit.js";
import InventoryItem from "../../models/InventoryItem.js";

export const getUnits = async (req, res) => {
  try {
    const { businessId } = req;
    const units = await InventoryUnit.find({ businessId }).sort({ name: 1 });
    res.json(units);
  } catch (error) {
    console.error("Error fetching units:", error.message);
    res.status(500).json({ message: "Failed to fetch units" });
  }
};

export const createUnit = async (req, res) => {
  try {
    const { businessId } = req;
    const { name, abbreviation } = req.body;
    if (!name || !abbreviation) {
      return res.status(400).json({ message: "Name and abbreviation are required" });
    }
    const unit = await InventoryUnit.create({ businessId, name, abbreviation });
    res.status(201).json(unit);
  } catch (error) {
    console.error("Error creating unit:", error.message);
    res.status(500).json({ message: "Failed to create unit" });
  }
};

export const deleteUnit = async (req, res) => {
  try {
    const { businessId } = req;
    const { id } = req.params;
    const inUse = await InventoryItem.exists({ unit: id, businessId });
    if (inUse) {
      return res.status(400).json({ message: "Unit is in use by one or more inventory items" });
    }
    const unit = await InventoryUnit.findOneAndDelete({ _id: id, businessId });
    if (!unit) return res.status(404).json({ message: "Unit not found" });
    res.json({ message: "Unit deleted" });
  } catch (error) {
    console.error("Error deleting unit:", error.message);
    res.status(500).json({ message: "Failed to delete unit" });
  }
};

// controllers/inventory/items.js
import InventoryItem from "../../models/InventoryItem.js";
import StockEntry from "../../models/StockEntry.js";
import InventoryUsageLog from "../../models/InventoryUsageLog.js";

export const getItems = async (req, res) => {
  try {
    const { businessId } = req;
    const filter = { businessId, ...(req.user.isAdmin ? {} : { isActive: true }) };
    const items = await InventoryItem.find(filter)
      .populate("unit", "name abbreviation")
      .sort({ category: 1, name: 1 });

    const responseItems = items.map((item) => ({
      ...item.toObject(),
      itemType: item.itemType || "raw_material",
    }));

    res.json(responseItems);
  } catch (error) {
    console.error("Error fetching inventory items:", error.message);
    res.status(500).json({ message: "Failed to fetch inventory items" });
  }
};

export const createItem = async (req, res) => {
  try {
    const { businessId } = req;
    const { name, unit, category, costPerUnit, reorderLevel, itemType } = req.body;
    if (!name || !unit) {
      return res.status(400).json({ message: "Name and unit are required" });
    }
    const item = await InventoryItem.create({
      businessId,
      name,
      unit,
      itemType: itemType || "raw_material",
      category: category || "General",
      costPerUnit: costPerUnit || 0,
      reorderLevel: reorderLevel || 0,
    });
    const populated = await item.populate("unit", "name abbreviation");
    res.status(201).json(populated);
  } catch (error) {
    console.error("Error creating inventory item:", error.message);
    res.status(500).json({ message: "Failed to create inventory item" });
  }
};

export const updateItem = async (req, res) => {
  try {
    const { businessId } = req;
    const { id } = req.params;
    const allowed = ["name", "unit", "category", "costPerUnit", "reorderLevel", "isActive", "itemType"];
    const updates = {};
    allowed.forEach((key) => {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    });

    if (!Object.keys(updates).length) {
      return res.status(400).json({ message: "No valid update fields provided" });
    }

    const item = await InventoryItem.findOneAndUpdate({ _id: id, businessId }, updates, {
      new: true,
      runValidators: true,
    }).populate("unit", "name abbreviation");

    if (!item) return res.status(404).json({ message: "Inventory item not found" });
    res.json(item);
  } catch (error) {
    console.error("Error updating inventory item:", error.message);
    res.status(500).json({ message: "Failed to update inventory item" });
  }
};

export const deleteItem = async (req, res) => {
  try {
    const { businessId } = req;
    const { id } = req.params;
    const hasHistory =
      (await StockEntry.exists({ item: id, businessId })) || (await InventoryUsageLog.exists({ item: id, businessId }));

    if (hasHistory) {
      const item = await InventoryItem.findOneAndUpdate({ _id: id, businessId }, { isActive: false }, { new: true });
      if (!item) return res.status(404).json({ message: "Inventory item not found" });
      return res.json({ message: "Item has stock history — deactivated instead of deleted", item });
    }

    const item = await InventoryItem.findOneAndDelete({ _id: id, businessId });
    if (!item) return res.status(404).json({ message: "Inventory item not found" });
    res.json({ message: "Inventory item deleted" });
  } catch (error) {
    console.error("Error deleting inventory item:", error.message);
    res.status(500).json({ message: "Failed to delete inventory item" });
  }
};

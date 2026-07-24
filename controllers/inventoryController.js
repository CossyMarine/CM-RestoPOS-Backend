// controllers/inventoryController.js
import InventoryUnit from "../models/InventoryUnit.js";
import InventoryItem from "../models/InventoryItem.js";
import StockEntry from "../models/StockEntry.js";
import InventoryUsageLog from "../models/InventoryUsageLog.js";

/* =================================================
   UNITS — admin-defined measurement units
================================================= */

// @desc    Get all measurement units
// @route   GET /api/inventory/units
// @access  Protected — admin
export const getUnits = async (req, res) => {
  try {
    const units = await InventoryUnit.find().sort({ name: 1 });
    res.json(units);
  } catch (error) {
    console.error("Error fetching units:", error.message);
    res.status(500).json({ message: "Failed to fetch units" });
  }
};

// @desc    Create a measurement unit (e.g. Kg, Litre, Sag, Korogoro)
// @route   POST /api/inventory/units
// @access  Protected — admin
export const createUnit = async (req, res) => {
  try {
    const { name, abbreviation } = req.body;
    if (!name || !abbreviation) {
      return res.status(400).json({ message: "Name and abbreviation are required" });
    }
    const unit = await InventoryUnit.create({ name, abbreviation });
    res.status(201).json(unit);
  } catch (error) {
    console.error("Error creating unit:", error.message);
    res.status(500).json({ message: "Failed to create unit" });
  }
};

// @desc    Delete a measurement unit
// @route   DELETE /api/inventory/units/:id
// @access  Protected — admin
export const deleteUnit = async (req, res) => {
  try {
    const { id } = req.params;
    const inUse = await InventoryItem.exists({ unit: id });
    if (inUse) {
      return res.status(400).json({ message: "Unit is in use by one or more inventory items" });
    }
    const unit = await InventoryUnit.findByIdAndDelete(id);
    if (!unit) return res.status(404).json({ message: "Unit not found" });
    res.json({ message: "Unit deleted" });
  } catch (error) {
    console.error("Error deleting unit:", error.message);
    res.status(500).json({ message: "Failed to delete unit" });
  }
};

/* =================================================
   ITEMS — admin-defined ingredients / stock catalog
================================================= */

// @desc    Get all inventory items (kitchen sees active only; admin sees all)
// @route   GET /api/inventory/items
// @access  Protected — admin, kitchen
export const getItems = async (req, res) => {
  try {
    const filter = req.user.isAdmin ? {} : { isActive: true };
    const items = await InventoryItem.find(filter)
      .populate("unit", "name abbreviation")
      .sort({ category: 1, name: 1 });
    res.json(items);
  } catch (error) {
    console.error("Error fetching inventory items:", error.message);
    res.status(500).json({ message: "Failed to fetch inventory items" });
  }
};

// @desc    Create an inventory item
// @route   POST /api/inventory/items
// @access  Protected — admin
export const createItem = async (req, res) => {
  try {
    const { name, unit, category, costPerUnit, reorderLevel } = req.body;
    if (!name || !unit) {
      return res.status(400).json({ message: "Name and unit are required" });
    }
    const item = await InventoryItem.create({
      name,
      unit,
      category:     category || "General",
      costPerUnit:  costPerUnit || 0,
      reorderLevel: reorderLevel || 0,
    });
    const populated = await item.populate("unit", "name abbreviation");
    res.status(201).json(populated);
  } catch (error) {
    console.error("Error creating inventory item:", error.message);
    res.status(500).json({ message: "Failed to create inventory item" });
  }
};

// @desc    Update an inventory item's details (not its stock — use /stock or /adjust for that)
// @route   PUT /api/inventory/items/:id
// @access  Protected — admin
export const updateItem = async (req, res) => {
  try {
    const { id } = req.params;
    const allowed = ["name", "unit", "category", "costPerUnit", "reorderLevel", "isActive"];
    const updates = {};
    allowed.forEach((key) => {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    });

    const item = await InventoryItem.findByIdAndUpdate(id, updates, {
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

// @desc    Delete an inventory item — hard-deletes only if it has no stock/usage history,
//          otherwise deactivates it so historical records stay intact
// @route   DELETE /api/inventory/items/:id
// @access  Protected — admin
export const deleteItem = async (req, res) => {
  try {
    const { id } = req.params;
    const hasHistory =
      (await StockEntry.exists({ item: id })) || (await InventoryUsageLog.exists({ item: id }));

    if (hasHistory) {
      const item = await InventoryItem.findByIdAndUpdate(id, { isActive: false }, { new: true });
      if (!item) return res.status(404).json({ message: "Inventory item not found" });
      return res.json({ message: "Item has stock history — deactivated instead of deleted", item });
    }

    const item = await InventoryItem.findByIdAndDelete(id);
    if (!item) return res.status(404).json({ message: "Inventory item not found" });
    res.json({ message: "Inventory item deleted" });
  } catch (error) {
    console.error("Error deleting inventory item:", error.message);
    res.status(500).json({ message: "Failed to delete inventory item" });
  }
};

/* =================================================
   STOCK ENTRIES — admin restocks + sets purchase price
================================================= */

// @desc    Add stock to an item (records the purchase price and bumps currentStock)
// @route   POST /api/inventory/stock
// @access  Protected — admin
export const addStock = async (req, res) => {
  try {
    const { item: itemId, quantity, costPerUnit, note } = req.body;
    if (!itemId || !quantity || costPerUnit === undefined) {
      return res.status(400).json({ message: "item, quantity and costPerUnit are required" });
    }
    if (quantity <= 0) {
      return res.status(400).json({ message: "quantity must be greater than 0" });
    }

    const item = await InventoryItem.findById(itemId);
    if (!item) return res.status(404).json({ message: "Inventory item not found" });

    const totalCost = quantity * costPerUnit;

    const entry = await StockEntry.create({
      item: itemId,
      quantity,
      costPerUnit,
      totalCost,
      addedBy: req.user._id,
      note: note || "",
    });

    item.currentStock += quantity;
    item.costPerUnit = costPerUnit; // latest purchase price becomes the running valuation cost
    await item.save();

    res.status(201).json({ entry, item });
  } catch (error) {
    console.error("Error adding stock:", error.message);
    res.status(500).json({ message: "Failed to add stock" });
  }
};

// @desc    Get stock restock history, optionally filtered by item
// @route   GET /api/inventory/stock?item=&page=&limit=
// @access  Protected — admin
export const getStockHistory = async (req, res) => {
  try {
    const { item, page = 1, limit = 25 } = req.query;
    const filter = item ? { item } : {};

    const entries = await StockEntry.find(filter)
      .populate("item", "name")
      .populate("addedBy", "fullName")
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit));

    const total = await StockEntry.countDocuments(filter);

    res.json({ entries, total, page: Number(page), totalPages: Math.ceil(total / limit) });
  } catch (error) {
    console.error("Error fetching stock history:", error.message);
    res.status(500).json({ message: "Failed to fetch stock history" });
  }
};

/* =================================================
   USAGE LOGS — kitchen records consumption/waste; admin can correct
================================================= */

// @desc    Log inventory usage or waste — decrements currentStock
// @route   POST /api/inventory/usage
// @access  Protected — admin, kitchen
export const logUsage = async (req, res) => {
  try {
    const { item: itemId, quantity, reason, note } = req.body;
    if (!itemId || !quantity) {
      return res.status(400).json({ message: "item and quantity are required" });
    }
    if (quantity <= 0) {
      return res.status(400).json({ message: "quantity must be greater than 0" });
    }
    if (reason && !["used", "waste"].includes(reason)) {
      return res.status(400).json({ message: "reason must be 'used' or 'waste'" });
    }

    const item = await InventoryItem.findById(itemId);
    if (!item) return res.status(404).json({ message: "Inventory item not found" });

    const totalValue = quantity * item.costPerUnit;

    const log = await InventoryUsageLog.create({
      item: itemId,
      quantity,
      reason: reason || "used",
      costPerUnit: item.costPerUnit,
      totalValue,
      recordedBy: req.user._id,
      note: note || "",
    });

    item.currentStock -= quantity;
    await item.save();

    res.status(201).json({ log, item });
  } catch (error) {
    console.error("Error logging usage:", error.message);
    res.status(500).json({ message: "Failed to log usage" });
  }
};

// @desc    Manually correct an item's stock (e.g. after a physical stock count)
// @route   POST /api/inventory/adjust
// @access  Protected — admin
export const adjustStock = async (req, res) => {
  try {
    const { item: itemId, delta, note } = req.body;
    if (!itemId || delta === undefined || delta === 0) {
      return res.status(400).json({ message: "item and a non-zero delta are required" });
    }

    const item = await InventoryItem.findById(itemId);
    if (!item) return res.status(404).json({ message: "Inventory item not found" });

    const totalValue = delta * item.costPerUnit;

    const log = await InventoryUsageLog.create({
      item: itemId,
      quantity: delta,
      reason: "adjustment",
      costPerUnit: item.costPerUnit,
      totalValue,
      recordedBy: req.user._id,
      note: note || "",
    });

    item.currentStock += delta;
    await item.save();

    res.status(201).json({ log, item });
  } catch (error) {
    console.error("Error adjusting stock:", error.message);
    res.status(500).json({ message: "Failed to adjust stock" });
  }
};

// @desc    Get usage/waste/adjustment history, optionally filtered by item or reason
// @route   GET /api/inventory/usage?item=&reason=&page=&limit=
// @access  Protected — admin
export const getUsageHistory = async (req, res) => {
  try {
    const { item, reason, page = 1, limit = 25 } = req.query;
    const filter = {};
    if (item) filter.item = item;
    if (reason) filter.reason = reason;

    const logs = await InventoryUsageLog.find(filter)
      .populate("item", "name")
      .populate("recordedBy", "fullName")
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit));

    const total = await InventoryUsageLog.countDocuments(filter);

    res.json({ logs, total, page: Number(page), totalPages: Math.ceil(total / limit) });
  } catch (error) {
    console.error("Error fetching usage history:", error.message);
    res.status(500).json({ message: "Failed to fetch usage history" });
  }
};

/* =================================================
   SUMMARY — feeds the "revenue minus stock budget" picture
================================================= */

// @desc    Get an inventory financial summary for an optional date range
// @route   GET /api/inventory/summary?startDate=&endDate=
// @access  Protected — admin
export const getInventorySummary = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const dateFilter = {};
    if (startDate) dateFilter.$gte = new Date(startDate);
    if (endDate) dateFilter.$lte = new Date(endDate);
    const createdAtFilter = Object.keys(dateFilter).length ? { createdAt: dateFilter } : {};

    const [stockAgg] = await StockEntry.aggregate([
      { $match: createdAtFilter },
      { $group: { _id: null, totalSpent: { $sum: "$totalCost" } } },
    ]);

    const usageBreakdown = await InventoryUsageLog.aggregate([
      { $match: { ...createdAtFilter, reason: { $in: ["used", "waste"] } } },
      { $group: { _id: "$reason", totalValue: { $sum: "$totalValue" } } },
    ]);

    const items = await InventoryItem.find({ isActive: true });
    const currentStockValue = items.reduce(
      (sum, item) => sum + item.currentStock * item.costPerUnit,
      0
    );
    const lowStockItems = items.filter(
      (item) => item.reorderLevel > 0 && item.currentStock <= item.reorderLevel
    );

    res.json({
      stockPurchasedCost: stockAgg?.totalSpent || 0,
      usageBreakdown: usageBreakdown.map((u) => ({ reason: u._id, totalValue: u.totalValue })),
      currentStockValue,
      lowStockCount: lowStockItems.length,
      lowStockItems: lowStockItems.map((i) => ({
        id: i._id,
        name: i.name,
        currentStock: i.currentStock,
        reorderLevel: i.reorderLevel,
      })),
    });
  } catch (error) {
    console.error("Error fetching inventory summary:", error.message);
    res.status(500).json({ message: "Failed to fetch inventory summary" });
  }
};

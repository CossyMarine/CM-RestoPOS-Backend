// controllers/inventory/stock.js
import InventoryItem from "../../models/InventoryItem.js";
import InventoryStock from "../../models/InventoryStock.js";
import InventoryBatch from "../../models/InventoryBatch.js";
import StockEntry from "../../models/StockEntry.js";
import InventoryUsageLog from "../../models/InventoryUsageLog.js";
import mongoose from "mongoose";
import {
  requireInventoryIds,
  resolveInventoryLocation,
  ensureLocationStockBalance,
  initializeUnbatchedQuantity,
  consumeBatchesForQuantity,
  buildBatchNumber,
} from "./helpers.js";

export const getLocationStock = async (req, res) => {
  try {
    const { businessId } = req;
    const { locationId } = req.params;
    const balances = await InventoryStock.find({ location: locationId, businessId })
      .populate({ path: "item", populate: { path: "unit", select: "name abbreviation" } })
      .populate("location", "name code")
      .sort({ createdAt: -1 });

    res.json(balances);
  } catch (error) {
    console.error("Error fetching location stock:", error.message);
    res.status(500).json({ message: "Failed to fetch location stock" });
  }
};

export const getItemLocationStock = async (req, res) => {
  try {
    const { businessId } = req;
    const { itemId } = req.params;
    const balances = await InventoryStock.find({ item: itemId, businessId })
      .populate({ path: "item", populate: { path: "unit", select: "name abbreviation" } })
      .populate("location", "name code")
      .sort({ createdAt: -1 });

    res.json(balances);
  } catch (error) {
    console.error("Error fetching item location stock:", error.message);
    res.status(500).json({ message: "Failed to fetch item location stock" });
  }
};

export const getAllLocationStock = async (req, res) => {
  try {
    const { businessId } = req;
    const balances = await InventoryStock.find({ businessId })
      .populate({ path: "item", populate: { path: "unit", select: "name abbreviation" } })
      .populate("location", "name code")
      .sort({ createdAt: -1 });

    res.json(balances);
  } catch (error) {
    console.error("Error fetching all location stock:", error.message);
    res.status(500).json({ message: "Failed to fetch all location stock" });
  }
};

export const addStock = async (req, res) => {
  try {
    const { businessId } = req;
    const { item: itemId, quantity, costPerUnit, note, locationId, batchNumber, manufacturingDate, expiryDate } = req.body;
    requireInventoryIds(req.body, [["item", "inventory item"], ["locationId", "location"]]);
    if (!itemId || !quantity || costPerUnit === undefined) {
      return res.status(400).json({ message: "item, quantity and costPerUnit are required" });
    }
    if (quantity <= 0) {
      return res.status(400).json({ message: "quantity must be greater than 0" });
    }

    const item = await InventoryItem.findOne({ _id: itemId, businessId });
    if (!item) return res.status(404).json({ message: "Inventory item not found" });

    const location = await resolveInventoryLocation(locationId, "Store", businessId);
    const totalCost = quantity * costPerUnit;
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      const stockBalance = await ensureLocationStockBalance(businessId, itemId, location._id, session);
      stockBalance.quantity += Number(quantity);
      await stockBalance.save({ session });
      item.currentStock += Number(quantity);
      item.costPerUnit = costPerUnit;
      await item.save({ session });
      const parsedManufacturingDate = manufacturingDate ? new Date(manufacturingDate) : undefined;
      const parsedExpiryDate = expiryDate ? new Date(expiryDate) : undefined;
      if ((parsedManufacturingDate && Number.isNaN(parsedManufacturingDate.getTime())) || (parsedExpiryDate && Number.isNaN(parsedExpiryDate.getTime()))) throw new Error("Invalid batch date");
      const batch = (await InventoryBatch.create([{
        businessId,
        batchNumber: await buildBatchNumber(businessId, itemId, location._id, batchNumber, session), inventoryItem: itemId, location: location._id,
        quantity: Number(quantity), unit: item.unit, costPerUnit: Number(costPerUnit), manufacturingDate: parsedManufacturingDate, expiryDate: parsedExpiryDate,
        status: "active", note: note || "",
      }], { session }))[0];
      const entry = (await StockEntry.create([{ businessId, item: itemId, location: location._id, batch: batch._id, quantity, costPerUnit, totalCost, addedBy: req.user._id, note: note || "" }], { session }))[0];
      await session.commitTransaction();
      session.endSession();
      res.status(201).json({ entry, item, batch });
    } catch (error) {
      await session.abortTransaction(); session.endSession(); throw error;
    }
  } catch (error) {
    if (error.message === "Inventory location not found" || error.message.includes("Default location")) {
      return res.status(404).json({ message: error.message });
    }
    console.error("Error adding stock:", error.message);
    res.status(500).json({ message: "Failed to add stock" });
  }
};

export const getStockHistory = async (req, res) => {
  try {
    const { businessId } = req;
    const { item, page = 1, limit = 25 } = req.query;
    const filter = { businessId, ...(item ? { item } : {}) };

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

export const adjustStock = async (req, res) => {
  try {
    const { businessId } = req;
    const { item: itemId, delta, note, locationId } = req.body;
    requireInventoryIds(req.body, [["item", "inventory item"], ["locationId", "location"]]);
    if (!itemId || delta === undefined || delta === 0) {
      return res.status(400).json({ message: "item and a non-zero delta are required" });
    }

    const item = await InventoryItem.findOne({ _id: itemId, businessId });
    if (!item) return res.status(404).json({ message: "Inventory item not found" });

    const location = await resolveInventoryLocation(locationId, "Store", businessId);
    const totalValue = delta * item.costPerUnit;
    const session = await mongoose.startSession(); session.startTransaction();
    try {
      const stockBalance = await ensureLocationStockBalance(businessId, itemId, location._id, session);
      let allocation = { batchUsage: [], legacyQuantityConsumed: 0 };
      if (Number(delta) < 0) {
        const requiredQuantity = Math.abs(Number(delta));
        if (Number(stockBalance.quantity) < requiredQuantity || Number(item.currentStock) < requiredQuantity) throw new Error("Location stock balance cannot be negative");
        allocation = await consumeBatchesForQuantity({ businessId, inventoryItemId: itemId, locationId: location._id, requiredQuantity, stockBalance, session });
      } else {
        await initializeUnbatchedQuantity(stockBalance, session);
        stockBalance.unbatchedQuantity += Number(delta);
      }
      stockBalance.quantity += Number(delta); await stockBalance.save({ session });
      item.currentStock += Number(delta); await item.save({ session });
      const log = (await InventoryUsageLog.create([{ businessId, item: itemId, location: location._id, quantity: delta, reason: "adjustment", costPerUnit: item.costPerUnit, totalValue, recordedBy: req.user._id, note: note || "", batchUsage: allocation.batchUsage, legacyQuantityConsumed: allocation.legacyQuantityConsumed }], { session }))[0];
      await session.commitTransaction(); session.endSession();
      res.status(201).json({ log, item });
    } catch (error) { await session.abortTransaction(); session.endSession(); throw error; }
  } catch (error) {
    if (error.message === "Inventory location not found" || error.message.includes("Default location")) {
      return res.status(404).json({ message: error.message });
    }
    console.error("Error adjusting stock:", error.message);
    res.status(500).json({ message: "Failed to adjust stock" });
  }
};

export const getInventorySummary = async (req, res) => {
  try {
    const { businessId } = req;
    const { startDate, endDate } = req.query;
    const dateFilter = {};
    if (startDate) dateFilter.$gte = new Date(startDate);
    if (endDate) dateFilter.$lte = new Date(endDate);
    const createdAtFilter = Object.keys(dateFilter).length ? { createdAt: dateFilter } : {};

    const [stockAgg] = await StockEntry.aggregate([
      { $match: { businessId: new mongoose.Types.ObjectId(businessId), ...createdAtFilter } },
      { $group: { _id: null, totalSpent: { $sum: "$totalCost" } } },
    ]);

    const usageBreakdown = await InventoryUsageLog.aggregate([
      { $match: { businessId: new mongoose.Types.ObjectId(businessId), ...createdAtFilter, reason: { $in: ["used", "waste"] } } },
      { $group: { _id: "$reason", totalValue: { $sum: "$totalValue" } } },
    ]);

    const items = await InventoryItem.find({ businessId, isActive: true });
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

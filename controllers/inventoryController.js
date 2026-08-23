// controllers/inventoryController.js
import InventoryUnit from "../models/InventoryUnit.js";
import InventoryItem from "../models/InventoryItem.js";
import InventoryLocation from "../models/InventoryLocation.js";
import InventoryStock from "../models/InventoryStock.js";
import InventoryTransfer from "../models/InventoryTransfer.js";
import Recipe from "../models/Recipe.js";
import MenuItem from "../models/MenuItem.js";
import StockEntry from "../models/StockEntry.js";
import InventoryUsageLog from "../models/InventoryUsageLog.js";
import Production from "../models/Production.js";
import InventoryReceiving from "../models/InventoryReceiving.js";
import Supplier from "../models/Supplier.js";
import PurchaseOrder from "../models/PurchaseOrder.js";
import InventoryWaste from "../models/InventoryWaste.js";
import InventoryBatch from "../models/InventoryBatch.js";
import mongoose from "mongoose";
const resolveInventoryLocation = async (locationId, fallbackName) => {
  if (locationId) {
    if (!isValidObjectId(locationId)) throw new Error("Invalid inventory location id");
    const location = await InventoryLocation.findById(locationId);
    if (!location) {
      throw new Error("Inventory location not found");
    }
    return location;
  }

  const fallbackLocation = await InventoryLocation.findOne({
    name: { $regex: `^${fallbackName}$`, $options: "i" },
  });

  if (!fallbackLocation) {
    throw new Error(`Default location '${fallbackName}' not found`);
  }

  return fallbackLocation;
};

const ensureLocationStockBalance = async (itemId, locationId, session = null) => {
  let balance = await InventoryStock.findOne({ item: itemId, location: locationId }).session(session);
  if (!balance) {
    const created = await InventoryStock.create([{ item: itemId, location: locationId, quantity: 0, unbatchedQuantity: 0 }], { session });
    balance = created[0];
  }
  return balance;
};

const isValidObjectId = (value) => {
  if (value === undefined || value === null || value === "") {
    return false;
  }
  return mongoose.Types.ObjectId.isValid(String(value));
};

const requireObjectId = (value, label) => {
  if (!isValidObjectId(value)) throw new Error(`Invalid ${label} id`);
  return value;
};

const initializeUnbatchedQuantity = async (stock, session = null) => {
  if (stock.unbatchedQuantity !== undefined && stock.unbatchedQuantity !== null) return stock;
  const [batchTotal] = await InventoryBatch.aggregate([
    { $match: { inventoryItem: stock.item, location: stock.location, status: { $ne: "cancelled" } } },
    { $group: { _id: null, quantity: { $sum: "$quantity" } } },
  ]).session(session);
  const unbatchedQuantity = Number(stock.quantity) - Number(batchTotal?.quantity || 0);
  if (unbatchedQuantity < -0.000001) throw new Error("Inventory batch reconciliation required");
  stock.unbatchedQuantity = Math.max(0, unbatchedQuantity);
  await stock.save({ session });
  return stock;
};

const getBatchStatus = (batchDoc, now = new Date()) => {
  if (batchDoc.status === "cancelled") {
    return "cancelled";
  }
  if (Number(batchDoc.quantity) <= 0) {
    return "depleted";
  }
  if (batchDoc.expiryDate && new Date(batchDoc.expiryDate) < now) {
    return "expired";
  }
  return "active";
};

const syncBatchStatus = async (batchDoc, session = null) => {
  const nextStatus = getBatchStatus(batchDoc);
  if (batchDoc.status !== nextStatus) {
    batchDoc.status = nextStatus;
    await batchDoc.save({ session });
  }
  return batchDoc;
};

const buildBatchNumber = async (inventoryItemId, locationId, suppliedBatchNumber, session = null) => {
  const normalized = typeof suppliedBatchNumber === "string" ? suppliedBatchNumber.trim() : "";
  if (normalized) {
    const duplicate = await InventoryBatch.findOne({
      inventoryItem: inventoryItemId,
      location: locationId,
      batchNumber: { $regex: `^${normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" },
    }).session(session);
    if (duplicate) {
      throw new Error("Batch number already exists");
    }
    return normalized;
  }

  const generated = `BATCH-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  const duplicate = await InventoryBatch.findOne({ inventoryItem: inventoryItemId, location: locationId, batchNumber: generated }).session(session);
  if (duplicate) {
    return buildBatchNumber(inventoryItemId, locationId, "", session);
  }
  return generated;
};

const consumeBatchesForQuantity = async ({ inventoryItemId, locationId, requiredQuantity, stockBalance, session = null, includeExpired = false }) => {
  const now = new Date();
  await initializeUnbatchedQuantity(stockBalance, session);
  const query = {
    inventoryItem: inventoryItemId,
    location: locationId,
    quantity: { $gt: 0 },
    status: { $ne: "cancelled" },
  };
  if (!includeExpired) {
    query.$or = [{ expiryDate: null }, { expiryDate: { $gte: now } }];
  }
  const batches = await InventoryBatch.find(query).sort({ createdAt: 1 }).session(session);
  batches.sort((a, b) => (a.expiryDate ? new Date(a.expiryDate) : new Date(8640000000000000)) - (b.expiryDate ? new Date(b.expiryDate) : new Date(8640000000000000)) || new Date(a.createdAt) - new Date(b.createdAt));

  let remaining = Number(requiredQuantity);
  const batchUsage = [];
  for (const batch of batches) {
    if (remaining <= 0) break;
    const available = Number(batch.quantity);
    if (available <= 0) continue;

    const consumed = Math.min(available, remaining);
    batch.quantity = Number(batch.quantity) - consumed;
    remaining -= consumed;
    batch.status = getBatchStatus(batch, now);
    await batch.save({ session });
    batchUsage.push({ batch: batch._id, quantityConsumed: consumed });
  }

  const legacyQuantityConsumed = Math.min(Number(stockBalance.unbatchedQuantity), remaining);
  stockBalance.unbatchedQuantity -= legacyQuantityConsumed;
  remaining -= legacyQuantityConsumed;

  if (remaining > 0) {
    if (!includeExpired) {
      const expiredAgg = await InventoryBatch.aggregate([
        { $match: { inventoryItem: inventoryItemId, location: locationId, quantity: { $gt: 0 }, status: { $ne: "cancelled" }, expiryDate: { $lt: now } } },
        { $group: { _id: null, total: { $sum: "$quantity" } } },
      ]).session(session);
      const expiredTotal = expiredAgg[0]?.total || 0;
      if (expiredTotal > 0) {
        throw new Error(`Short by ${remaining} — ${expiredTotal} more is sitting here but expired, so it can't be used. Log it as waste instead.`);
      }
    }
    throw new Error(`Not enough stock here — short by ${remaining}`);
  }

  return { batchUsage, legacyQuantityConsumed };
};

const restoreBatchQuantity = async (batchId, quantity, session = null) => {
  const batch = await InventoryBatch.findById(batchId).session(session);
  if (!batch) {
    throw new Error("Batch not found");
  }
  batch.quantity = Number(batch.quantity) + Number(quantity);
  batch.status = getBatchStatus(batch);
  await batch.save({ session });
  return batch;
};

const restoreConsumptionPlan = async ({ stockBalance, batchUsage = [], legacyQuantityConsumed = 0, session = null }) => {
  for (const usage of batchUsage) await restoreBatchQuantity(usage.batch, usage.quantityConsumed, session);
  await initializeUnbatchedQuantity(stockBalance, session);
  stockBalance.unbatchedQuantity += Number(legacyQuantityConsumed || 0);
};

const requireInventoryIds = (payload, fields) => {
  for (const [field, label] of fields) {
    if (payload[field] !== undefined && payload[field] !== null && payload[field] !== "") requireObjectId(payload[field], label);
  }
};

export const consumeRecipeIngredientsForOrder = async (order, reqUserId, session = null) => {
  if (!order || !order.items || order.items.length === 0) {
    return { consumed: false, reason: "No items" };
  }

  const kitchenLocation = await InventoryLocation.findOne({
    $or: [{ name: /^kitchen$/i }, { code: /^kitchen$/i }],
  });

  if (!kitchenLocation) {
    return { consumed: false, reason: "Kitchen location not found" };
  }

  const consumptionPlan = [];
  const seenItems = new Map();

  for (const orderItem of order.items) {
    const menuItemId = orderItem.menuItemId;
    if (!menuItemId) continue;

    if (!seenItems.has(String(menuItemId))) {
      seenItems.set(String(menuItemId), true);
    }

    const recipe = await Recipe.findOne({ menuItem: menuItemId, isActive: true }).lean();
    if (!recipe || !recipe.ingredients || recipe.ingredients.length === 0) {
      continue;
    }

    for (const ingredient of recipe.ingredients) {
      const requiredQuantity = Number(ingredient.quantity) * Number(orderItem.quantity);
      if (!requiredQuantity || requiredQuantity <= 0) continue;

      const existing = consumptionPlan.find((entry) => String(entry.inventoryItem) === String(ingredient.inventoryItem));
      if (existing) {
        existing.quantity += requiredQuantity;
      } else {
        consumptionPlan.push({
          inventoryItem: ingredient.inventoryItem,
          quantity: requiredQuantity,
          unit: ingredient.unit,
        });
      }
    }
  }

  if (consumptionPlan.length === 0) {
    return { consumed: false, reason: "No active recipe ingredients" };
  }

  const kitchenBalanceMap = new Map();

  for (const plan of consumptionPlan) {
    const inventoryItem = await InventoryItem.findById(plan.inventoryItem);
    if (!inventoryItem) {
      return { consumed: false, reason: "Inventory item not found" };
    }

    const kitchenBalance = await ensureLocationStockBalance(inventoryItem._id, kitchenLocation._id, session);
    kitchenBalanceMap.set(String(inventoryItem._id), kitchenBalance);

    if (kitchenBalance.quantity < plan.quantity) {
      return { consumed: false, reason: `Insufficient stock for ${inventoryItem.name}` };
    }
  }

  const usageLogs = [];

  for (const plan of consumptionPlan) {
    const inventoryItem = await InventoryItem.findById(plan.inventoryItem);
    if (!inventoryItem) {
      return { consumed: false, reason: "Inventory item not found" };
    }

    const balance = kitchenBalanceMap.get(String(inventoryItem._id));
    const allocation = await consumeBatchesForQuantity({
      inventoryItemId: inventoryItem._id,
      locationId: kitchenLocation._id,
      requiredQuantity: plan.quantity,
      stockBalance: balance,
      session,
    });
    balance.quantity -= plan.quantity;
    await balance.save({ session });

    inventoryItem.currentStock -= plan.quantity;
    await inventoryItem.save({ session });

    const totalValue = plan.quantity * inventoryItem.costPerUnit;
    const usageLog = await InventoryUsageLog.create(
      [{
        item: inventoryItem._id,
        location: kitchenLocation._id,
        quantity: plan.quantity,
        reason: "used",
        costPerUnit: inventoryItem.costPerUnit,
        totalValue,
        recordedBy: reqUserId,
        note: `Recipe consumption for order ${order._id}`,
        batchUsage: allocation.batchUsage,
        legacyQuantityConsumed: allocation.legacyQuantityConsumed,
      }],
      { session }
    );

    usageLogs.push(usageLog[0]);
  }

  return { consumed: true, logs: usageLogs, location: kitchenLocation };
};

const validateReceivingPayload = async (payload) => {
  const { location, items } = payload;

  if (!location) {
    throw new Error("location is required");
  }

  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("At least one item is required");
  }

  const locationDoc = await InventoryLocation.findById(location);
  if (!locationDoc) {
    throw new Error("Inventory location not found");
  }

  if (!locationDoc.isActive) {
    throw new Error("Inventory location is not active");
  }

  const seenItems = new Set();

  for (const item of items) {
    if (!item.inventoryItem) {
      throw new Error("Each item requires an inventoryItem");
    }
    if (!item.unit) {
      throw new Error("Each item requires a unit");
    }
    if (!item.quantity || Number(item.quantity) <= 0) {
      throw new Error("Each item quantity must be greater than 0");
    }
    if (item.costPerUnit === undefined || item.costPerUnit === null || Number(item.costPerUnit) < 0) {
      throw new Error("Each item costPerUnit must be greater than or equal to 0");
    }

    const inventoryItem = await InventoryItem.findById(item.inventoryItem);
    if (!inventoryItem) {
      throw new Error("Inventory item not found");
    }
    if (!inventoryItem.isActive) {
      throw new Error("Inventory item is not active");
    }

    const unitDoc = await InventoryUnit.findById(item.unit);
    if (!unitDoc) {
      throw new Error("Unit not found");
    }

    if (String(inventoryItem.unit) !== String(item.unit)) {
      throw new Error("Item unit must match the inventory item's configured unit");
    }

    const key = String(item.inventoryItem);
    if (seenItems.has(key)) {
      throw new Error("Duplicate inventory item in receiving");
    }
    seenItems.add(key);
  }

  return { locationDoc };
};

export const createReceiving = async (req, res) => {
  try {
    const { supplierName, supplier, purchaseOrder, referenceNumber, location, items, note } = req.body;

    requireObjectId(location, "location");
    if (supplier) requireObjectId(supplier, "supplier");
    if (purchaseOrder) requireObjectId(purchaseOrder, "purchase order");
    for (const item of items || []) requireInventoryIds(item, [["inventoryItem", "inventory item"], ["unit", "unit"]]);

    const payload = { location, items };
    await validateReceivingPayload(payload);

    const locationDoc = await InventoryLocation.findById(location);

    let supplierDoc = null;
    if (supplier) {
      supplierDoc = await Supplier.findById(supplier);
      if (!supplierDoc) {
        return res.status(404).json({ message: "Supplier not found" });
      }
      if (!supplierDoc.isActive) {
        return res.status(400).json({ message: "Supplier is not active" });
      }
    }

    let purchaseOrderDoc = null;
    if (purchaseOrder) {
      purchaseOrderDoc = await PurchaseOrder.findById(purchaseOrder);
      if (!purchaseOrderDoc) {
        return res.status(404).json({ message: "Purchase order not found" });
      }
      if (purchaseOrderDoc.status === "cancelled") {
        return res.status(400).json({ message: "Purchase order is cancelled" });
      }
      if (purchaseOrderDoc.status === "received") {
        return res.status(400).json({ message: "Purchase order is already fully received" });
      }
      if (supplierDoc && String(supplierDoc._id) !== String(purchaseOrderDoc.supplier)) {
        return res.status(400).json({ message: "Supplier mismatch" });
      }
      if (String(locationDoc._id) !== String(purchaseOrderDoc.location)) {
        return res.status(400).json({ message: "Location mismatch" });
      }
    }

    const normalizedItems = [];
    for (const item of items) {
      const normalizedItem = {
        inventoryItem: item.inventoryItem,
        quantity: Number(item.quantity),
        unit: item.unit,
        costPerUnit: Number(item.costPerUnit),
        totalCost: Number(item.quantity) * Number(item.costPerUnit),
        batchNumber: item.batchNumber ? String(item.batchNumber).trim() : "",
        manufacturingDate: undefined,
        expiryDate: undefined,
        batchNote: item.batchNote || "",
      };

      if (item.manufacturingDate) {
        const manufacturingDate = new Date(item.manufacturingDate);
        if (Number.isNaN(manufacturingDate.getTime())) {
          throw new Error("Invalid manufacturing date");
        }
        normalizedItem.manufacturingDate = manufacturingDate;
      }

      if (item.expiryDate) {
        const expiryDate = new Date(item.expiryDate);
        if (Number.isNaN(expiryDate.getTime())) {
          throw new Error("Invalid expiry date");
        }
        normalizedItem.expiryDate = expiryDate;
      }

      if (normalizedItem.manufacturingDate && normalizedItem.expiryDate && normalizedItem.expiryDate < normalizedItem.manufacturingDate) {
        throw new Error("Expiry date cannot be earlier than manufacturing date");
      }

      normalizedItems.push(normalizedItem);
    }

    if (purchaseOrderDoc) {
      const poItemMap = new Map(purchaseOrderDoc.items.map((item) => [String(item.inventoryItem), item]));
      for (const item of normalizedItems) {
        const poItem = poItemMap.get(String(item.inventoryItem));
        if (!poItem) {
          return res.status(400).json({ message: "Receiving item not present on purchase order" });
        }
        const remaining = Number(poItem.quantityOrdered) - Number(poItem.quantityReceived);
        if (item.quantity > remaining) {
          return res.status(400).json({ message: "Receiving quantity exceeds remaining purchase order quantity" });
        }
      }
    }

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const receiving = await InventoryReceiving.create([
        {
          supplierName: supplierName || "",
          referenceNumber: referenceNumber || "",
          location: locationDoc._id,
          supplier: supplierDoc?._id || undefined,
          purchaseOrder: purchaseOrderDoc?._id || undefined,
          items: normalizedItems,
          receivedBy: req.user._id,
          note: note || "",
          status: "received",
        },
      ], { session });

      for (const [index, item] of normalizedItems.entries()) {
        const inventoryItem = await InventoryItem.findById(item.inventoryItem).session(session);
        if (!inventoryItem) {
          throw new Error("Inventory item not found");
        }

        let stockBalance = await InventoryStock.findOne({ item: item.inventoryItem, location: locationDoc._id }).session(session);
        if (!stockBalance) {
          stockBalance = await InventoryStock.create([{ item: item.inventoryItem, location: locationDoc._id, quantity: 0 }], { session });
          stockBalance = stockBalance[0];
        }

        stockBalance.quantity += item.quantity;
        await stockBalance.save({ session });

        inventoryItem.currentStock += item.quantity;
        inventoryItem.costPerUnit = item.costPerUnit;
        await inventoryItem.save({ session });

        const hasBatchInfo = Boolean(item.batchNumber || item.batchNote || item.manufacturingDate || item.expiryDate);
        if (hasBatchInfo) {
          const batchNumber = await buildBatchNumber(item.inventoryItem, locationDoc._id, item.batchNumber, session);
          const batch = await InventoryBatch.create([
            {
              batchNumber,
              inventoryItem: item.inventoryItem,
              location: locationDoc._id,
              quantity: item.quantity,
              unit: item.unit,
              costPerUnit: item.costPerUnit,
              manufacturingDate: item.manufacturingDate,
              expiryDate: item.expiryDate,
              supplier: supplierDoc?._id,
              receiving: receiving[0]._id,
              status: getBatchStatus({ quantity: item.quantity, expiryDate: item.expiryDate, status: "active" }),
              note: item.batchNote || "",
            },
          ], { session });
          receiving[0].items[index].batch = batch[0]._id;
        } else {
          // New receipts are always traceable; generated batches preserve the
          // old payload shape while keeping legacy stock separate.
          const batchNumber = await buildBatchNumber(item.inventoryItem, locationDoc._id, "", session);
          const batch = await InventoryBatch.create([{
            batchNumber, inventoryItem: item.inventoryItem, location: locationDoc._id,
            quantity: item.quantity, unit: item.unit, costPerUnit: item.costPerUnit,
            supplier: supplierDoc?._id, receiving: receiving[0]._id, status: "active", note: "",
          }], { session });
          receiving[0].items[index].batch = batch[0]._id;
        }

        await StockEntry.create([
          {
            item: item.inventoryItem,
            quantity: item.quantity,
            costPerUnit: item.costPerUnit,
            totalCost: item.totalCost,
            addedBy: req.user._id,
            location: locationDoc._id,
            batch: receiving[0].items[index].batch,
            note: `Receiving ${receiving[0]._id}`,
          },
        ], { session });
      }

      await receiving[0].save({ session });

      if (purchaseOrderDoc) {
        for (const item of normalizedItems) {
          const poItem = purchaseOrderDoc.items.find((entry) => String(entry.inventoryItem) === String(item.inventoryItem));
          if (!poItem) continue;
          poItem.quantityReceived = Number(poItem.quantityReceived) + Number(item.quantity);
        }

        const allReceived = purchaseOrderDoc.items.every((item) => Number(item.quantityReceived) >= Number(item.quantityOrdered));
        purchaseOrderDoc.status = allReceived ? "received" : "partially_received";
        await purchaseOrderDoc.save({ session });
      }

      await session.commitTransaction();
      session.endSession();

      const populatedReceiving = await InventoryReceiving.findById(receiving[0]._id)
        .populate({ path: "location", select: "name code" })
        .populate({ path: "items.inventoryItem", populate: { path: "unit", select: "name abbreviation" } })
        .populate({ path: "items.unit", select: "name abbreviation" })
        .populate("receivedBy", "fullName")
        .populate("supplier", "name phone email contactPerson isActive");

      res.status(201).json(populatedReceiving);
    } catch (error) {
  if (session.inTransaction()) {
    await session.abortTransaction();
  }

  session.endSession();
  throw error;
}
  } catch (error) {
    if (error.message === "location is required") {
      return res.status(400).json({ message: error.message });
    }
    if (error.message === "At least one item is required") {
      return res.status(400).json({ message: error.message });
    }
    if (error.message === "Inventory location not found") {
      return res.status(404).json({ message: error.message });
    }
    if (error.message === "Inventory location is not active") {
      return res.status(400).json({ message: error.message });
    }
    if (error.message === "Each item requires an inventoryItem") {
      return res.status(400).json({ message: error.message });
    }
    if (error.message === "Each item requires a unit") {
      return res.status(400).json({ message: error.message });
    }
    if (error.message === "Each item quantity must be greater than 0") {
      return res.status(400).json({ message: error.message });
    }
    if (error.message === "Each item costPerUnit must be greater than or equal to 0") {
      return res.status(400).json({ message: error.message });
    }
    if (error.message === "Inventory item not found") {
      return res.status(404).json({ message: error.message });
    }
    if (error.message === "Inventory item is not active") {
      return res.status(400).json({ message: error.message });
    }
    if (error.message === "Unit not found") {
      return res.status(404).json({ message: error.message });
    }
    if (error.message === "Item unit must match the inventory item's configured unit") {
      return res.status(400).json({ message: error.message });
    }
    if (error.message === "Duplicate inventory item in receiving") {
      return res.status(400).json({ message: error.message });
    }
    if (error.message === "Invalid manufacturing date") {
      return res.status(400).json({ message: error.message });
    }
    if (error.message === "Invalid expiry date") {
      return res.status(400).json({ message: error.message });
    }
    if (error.message === "Expiry date cannot be earlier than manufacturing date") {
      return res.status(400).json({ message: error.message });
    }
    if (error.message === "Batch number already exists") {
      return res.status(400).json({ message: error.message });
    }
    if (error.message === "Purchase order not found") {
      return res.status(404).json({ message: error.message });
    }
    if (error.message === "Purchase order is cancelled") {
      return res.status(400).json({ message: error.message });
    }
    if (error.message === "Purchase order is already fully received") {
      return res.status(400).json({ message: error.message });
    }
    if (error.message === "Supplier mismatch") {
      return res.status(400).json({ message: error.message });
    }
    if (error.message === "Location mismatch") {
      return res.status(400).json({ message: error.message });
    }
    if (error.message === "Receiving item not present on purchase order") {
      return res.status(400).json({ message: error.message });
    }
    if (error.message === "Receiving quantity exceeds remaining purchase order quantity") {
      return res.status(400).json({ message: error.message });
    }
    console.error("Error creating receiving:", error.message);
    res.status(500).json({ message: "Failed to create receiving" });
  }
};

export const getReceivings = async (req, res) => {
  try {
    const receipts = await InventoryReceiving.find()
      .populate({ path: "location", select: "name code" })
      .populate({ path: "items.inventoryItem", populate: { path: "unit", select: "name abbreviation" } })
      .populate({ path: "items.unit", select: "name abbreviation" })
      .populate("receivedBy", "fullName")
      .populate("supplier", "name phone email contactPerson isActive")
      .populate("purchaseOrder", "poNumber status")
      .sort({ createdAt: -1 });

    res.json(receipts);
  } catch (error) {
    console.error("Error fetching receiving records:", error.message);
    res.status(500).json({ message: "Failed to fetch receiving records" });
  }
};

export const getReceivingById = async (req, res) => {
  try {
    const { id } = req.params;
    const receiving = await InventoryReceiving.findById(id)
      .populate({ path: "location", select: "name code" })
      .populate({ path: "items.inventoryItem", populate: { path: "unit", select: "name abbreviation" } })
      .populate({ path: "items.unit", select: "name abbreviation" })
      .populate("receivedBy", "fullName")
      .populate("supplier", "name phone email contactPerson isActive")
      .populate("purchaseOrder", "poNumber status")
      .populate("purchaseOrder", "poNumber status");

    if (!receiving) {
      return res.status(404).json({ message: "Receiving record not found" });
    }

    res.json(receiving);
  } catch (error) {
    console.error("Error fetching receiving record:", error.message);
    res.status(500).json({ message: "Failed to fetch receiving record" });
  }
};

export const cancelReceiving = async (req, res) => {
  try {
    const { id } = req.params;
    requireObjectId(id, "receiving");
    const receiving = await InventoryReceiving.findById(id);

    if (!receiving) {
      return res.status(404).json({ message: "Receiving record not found" });
    }

    if (receiving.status === "cancelled") {
      return res.status(400).json({ message: "Receiving is already cancelled" });
    }

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      for (const item of receiving.items) {
        const inventoryItem = await InventoryItem.findById(item.inventoryItem).session(session);
        if (!inventoryItem) {
          throw new Error("Inventory item not found");
        }

        const stockBalance = await InventoryStock.findOne({ item: item.inventoryItem, location: receiving.location }).session(session);
        if (!stockBalance) {
          throw new Error("Inventory stock balance not found");
        }

        if (stockBalance.quantity < item.quantity) {
          throw new Error("Cannot cancel receiving because stock would become negative");
        }

        await initializeUnbatchedQuantity(stockBalance, session);
        if (item.batch) {
          const batch = await InventoryBatch.findById(item.batch).session(session);
          if (!batch || batch.status === "cancelled" || Number(batch.quantity) < Number(item.quantity)) {
            throw new Error("Cannot cancel receiving because its batch stock was used");
          }
          batch.quantity -= Number(item.quantity);
          batch.status = Number(batch.quantity) === 0 ? "cancelled" : getBatchStatus(batch);
          await batch.save({ session });
        } else if (Number(stockBalance.unbatchedQuantity) < Number(item.quantity)) {
          throw new Error("Cannot cancel receiving because its legacy stock was used");
        } else {
          stockBalance.unbatchedQuantity -= Number(item.quantity);
        }

        stockBalance.quantity -= item.quantity;
        await stockBalance.save({ session });

        inventoryItem.currentStock -= item.quantity;
        await inventoryItem.save({ session });
      }

      if (receiving.purchaseOrder) {
        const purchaseOrder = await PurchaseOrder.findById(receiving.purchaseOrder).session(session);
        if (!purchaseOrder) throw new Error("Purchase order not found");
        for (const receivedItem of receiving.items) {
          const poItem = purchaseOrder.items.find((entry) => String(entry.inventoryItem) === String(receivedItem.inventoryItem));
          if (!poItem || Number(poItem.quantityReceived) < Number(receivedItem.quantity)) {
            throw new Error("Purchase order receiving reconciliation failed");
          }
          poItem.quantityReceived -= Number(receivedItem.quantity);
        }
        const allReceived = purchaseOrder.items.every((item) => Number(item.quantityReceived) >= Number(item.quantityOrdered));
        const anyReceived = purchaseOrder.items.some((item) => Number(item.quantityReceived) > 0);
        purchaseOrder.status = allReceived ? "received" : anyReceived ? "partially_received" : "ordered";
        await purchaseOrder.save({ session });
      }

      receiving.status = "cancelled";
      await receiving.save({ session });

      await session.commitTransaction();
      session.endSession();

      const populatedReceiving = await InventoryReceiving.findById(receiving._id)
        .populate({ path: "location", select: "name code" })
        .populate({ path: "items.inventoryItem", populate: { path: "unit", select: "name abbreviation" } })
        .populate({ path: "items.unit", select: "name abbreviation" })
        .populate("receivedBy", "fullName")
        .populate("supplier", "name phone email contactPerson isActive");

      res.json(populatedReceiving);
    } catch (error) {
      await session.abortTransaction();
      session.endSession();
      throw error;
    }
  } catch (error) {
    if (error.message === "Inventory item not found") {
      return res.status(404).json({ message: error.message });
    }
    if (error.message === "Inventory stock balance not found") {
      return res.status(404).json({ message: error.message });
    }
    if (error.message === "Cannot cancel receiving because stock would become negative") {
      return res.status(400).json({ message: error.message });
    }
    console.error("Error cancelling receiving:", error.message);
    res.status(500).json({ message: "Failed to cancel receiving" });
  }
};

export const createSupplier = async (req, res) => {
  try {
    const { name, phone, email, address, contactPerson, note } = req.body;

    const normalizedName = typeof name === "string" ? name.trim() : "";
    if (!normalizedName) {
      return res.status(400).json({ message: "Name is required" });
    }

    const normalizedEmail = typeof email === "string" ? email.trim().toLowerCase() : "";

    const existingSupplier = await Supplier.findOne({ name: { $regex: `^${normalizedName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" }, isActive: true });
    if (existingSupplier) {
      return res.status(400).json({ message: "Supplier name already exists" });
    }

    const supplier = await Supplier.create({
      name: normalizedName,
      phone: phone || "",
      email: normalizedEmail,
      address: address || "",
      contactPerson: contactPerson || "",
      note: note || "",
      isActive: true,
    });

    res.status(201).json(supplier);
  } catch (error) {
    console.error("Error creating supplier:", error.message);
    res.status(500).json({ message: "Failed to create supplier" });
  }
};

export const getSuppliers = async (req, res) => {
  try {
    const filter = req.query.includeInactive === "true" ? {} : { isActive: true };
    const suppliers = await Supplier.find(filter).sort({ name: 1 });
    res.json(suppliers);
  } catch (error) {
    console.error("Error fetching suppliers:", error.message);
    res.status(500).json({ message: "Failed to fetch suppliers" });
  }
};

export const getSupplierById = async (req, res) => {
  try {
    const { id } = req.params;
    const supplier = await Supplier.findById(id);
    if (!supplier) return res.status(404).json({ message: "Supplier not found" });
    res.json(supplier);
  } catch (error) {
    console.error("Error fetching supplier:", error.message);
    res.status(500).json({ message: "Failed to fetch supplier" });
  }
};

export const updateSupplier = async (req, res) => {
  try {
    const { id } = req.params;
    const supplier = await Supplier.findById(id);
    if (!supplier) return res.status(404).json({ message: "Supplier not found" });

    const allowedFields = ["name", "phone", "email", "address", "contactPerson", "note", "isActive"];
    const updates = {};

    allowedFields.forEach((field) => {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    });

    if (updates.name !== undefined) {
      const normalizedName = updates.name.trim();
      if (!normalizedName) {
        return res.status(400).json({ message: "Name is required" });
      }
      updates.name = normalizedName;
      const duplicate = await Supplier.findOne({
        _id: { $ne: id },
        name: { $regex: `^${normalizedName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" },
        isActive: true,
      });
      if (duplicate) {
        return res.status(400).json({ message: "Supplier name already exists" });
      }
    }

    if (updates.email !== undefined && typeof updates.email === "string") {
      updates.email = updates.email.trim().toLowerCase();
    }

    Object.assign(supplier, updates);
    await supplier.save();

    res.json(supplier);
  } catch (error) {
    console.error("Error updating supplier:", error.message);
    res.status(500).json({ message: "Failed to update supplier" });
  }
};

export const deleteSupplier = async (req, res) => {
  try {
    const { id } = req.params;
    const supplier = await Supplier.findById(id);
    if (!supplier) return res.status(404).json({ message: "Supplier not found" });

    supplier.isActive = false;
    await supplier.save();

    res.json({ message: "Supplier deactivated", supplier });
  } catch (error) {
    console.error("Error deactivating supplier:", error.message);
    res.status(500).json({ message: "Failed to deactivate supplier" });
  }
};

export const getSupplierReceivings = async (req, res) => {
  try {
    const { id } = req.params;
    const supplier = await Supplier.findById(id);
    if (!supplier) return res.status(404).json({ message: "Supplier not found" });

    const receivings = await InventoryReceiving.find({ supplier: id })
      .populate({ path: "location", select: "name code" })
      .populate({ path: "items.inventoryItem", populate: { path: "unit", select: "name abbreviation" } })
      .populate({ path: "items.unit", select: "name abbreviation" })
      .populate("receivedBy", "fullName")
      .sort({ createdAt: -1 });

    res.json(receivings);
  } catch (error) {
    console.error("Error fetching supplier receiving history:", error.message);
    res.status(500).json({ message: "Failed to fetch supplier receiving history" });
  }
};

const getNextPurchaseOrderNumber = async () => {
  const lastOrder = await PurchaseOrder.findOne({ poNumber: { $regex: /^PO-\d+$/ } }).sort({ poNumber: -1 });
  if (!lastOrder) return "PO-000001";
  const match = lastOrder.poNumber.match(/^(PO-)(\d+)$/);
  if (!match) return "PO-000001";
  const nextNumber = Number(match[2]) + 1;
  return `${match[1]}${String(nextNumber).padStart(6, "0")}`;
};

const validatePurchaseOrderPayload = async (payload) => {
  const { supplier, location, items } = payload;

  if (!supplier) {
    throw new Error("supplier is required");
  }

  if (!location) {
    throw new Error("location is required");
  }

  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("At least one item is required");
  }

  const supplierDoc = await Supplier.findById(supplier);
  if (!supplierDoc) {
    throw new Error("Supplier not found");
  }
  if (!supplierDoc.isActive) {
    throw new Error("Supplier is not active");
  }

  const locationDoc = await InventoryLocation.findById(location);
  if (!locationDoc) {
    throw new Error("Inventory location not found");
  }
  if (!locationDoc.isActive) {
    throw new Error("Inventory location is not active");
  }

  const seenItems = new Set();

  for (const item of items) {
    if (!item.inventoryItem) {
      throw new Error("Each item requires an inventoryItem");
    }
    if (!item.unit) {
      throw new Error("Each item requires a unit");
    }
    if (!item.quantityOrdered || Number(item.quantityOrdered) <= 0) {
      throw new Error("Each item quantity must be greater than 0");
    }
    if (item.costPerUnit === undefined || item.costPerUnit === null || Number(item.costPerUnit) < 0) {
      throw new Error("Each item costPerUnit must be greater than or equal to 0");
    }

    const inventoryItem = await InventoryItem.findById(item.inventoryItem);
    if (!inventoryItem) {
      throw new Error("Inventory item not found");
    }
    if (!inventoryItem.isActive) {
      throw new Error("Inventory item is not active");
    }

    const unitDoc = await InventoryUnit.findById(item.unit);
    if (!unitDoc) {
      throw new Error("Unit not found");
    }

    if (String(inventoryItem.unit) !== String(item.unit)) {
      throw new Error("Item unit must match the inventory item's configured unit");
    }

    const key = String(item.inventoryItem);
    if (seenItems.has(key)) {
      throw new Error("Duplicate inventory item in purchase order");
    }
    seenItems.add(key);
  }

  return { supplierDoc, locationDoc };
};

export const createPurchaseOrder = async (req, res) => {
  try {
    const { supplier, location, items, note } = req.body;
    const payload = { supplier, location, items };
    await validatePurchaseOrderPayload(payload);

    const poNumber = await getNextPurchaseOrderNumber();
    const normalizedItems = items.map((item) => ({
      inventoryItem: item.inventoryItem,
      quantityOrdered: Number(item.quantityOrdered),
      quantityReceived: 0,
      unit: item.unit,
      costPerUnit: Number(item.costPerUnit),
      totalCost: Number(item.quantityOrdered) * Number(item.costPerUnit),
    }));

    const purchaseOrder = await PurchaseOrder.create({
      poNumber,
      supplier,
      location,
      orderedBy: req.user._id,
      items: normalizedItems,
      note: note || "",
      status: "draft",
    });

    const populatedPurchaseOrder = await PurchaseOrder.findById(purchaseOrder._id)
      .populate("supplier", "name phone email contactPerson isActive")
      .populate({ path: "location", select: "name code" })
      .populate("orderedBy", "fullName")
      .populate({ path: "items.inventoryItem", populate: { path: "unit", select: "name abbreviation" } })
      .populate({ path: "items.unit", select: "name abbreviation" });

    res.status(201).json(populatedPurchaseOrder);
  } catch (error) {
    if (error.message === "supplier is required") {
      return res.status(400).json({ message: error.message });
    }
    if (error.message === "location is required") {
      return res.status(400).json({ message: error.message });
    }
    if (error.message === "At least one item is required") {
      return res.status(400).json({ message: error.message });
    }
    if (error.message === "Supplier not found") {
      return res.status(404).json({ message: error.message });
    }
    if (error.message === "Supplier is not active") {
      return res.status(400).json({ message: error.message });
    }
    if (error.message === "Inventory location not found") {
      return res.status(404).json({ message: error.message });
    }
    if (error.message === "Inventory location is not active") {
      return res.status(400).json({ message: error.message });
    }
    if (error.message === "Each item requires an inventoryItem") {
      return res.status(400).json({ message: error.message });
    }
    if (error.message === "Each item requires a unit") {
      return res.status(400).json({ message: error.message });
    }
    if (error.message === "Each item quantity must be greater than 0") {
      return res.status(400).json({ message: error.message });
    }
    if (error.message === "Each item costPerUnit must be greater than or equal to 0") {
      return res.status(400).json({ message: error.message });
    }
    if (error.message === "Inventory item not found") {
      return res.status(404).json({ message: error.message });
    }
    if (error.message === "Inventory item is not active") {
      return res.status(400).json({ message: error.message });
    }
    if (error.message === "Unit not found") {
      return res.status(404).json({ message: error.message });
    }
    if (error.message === "Item unit must match the inventory item's configured unit") {
      return res.status(400).json({ message: error.message });
    }
    if (error.message === "Duplicate inventory item in purchase order") {
      return res.status(400).json({ message: error.message });
    }
    console.error("Error creating purchase order:", error.message);
    res.status(500).json({ message: "Failed to create purchase order" });
  }
};

export const getPurchaseOrders = async (req, res) => {
  try {
    const purchaseOrders = await PurchaseOrder.find()
      .populate("supplier", "name phone email contactPerson isActive")
      .populate({ path: "location", select: "name code" })
      .populate("orderedBy", "fullName")
      .populate({ path: "items.inventoryItem", populate: { path: "unit", select: "name abbreviation" } })
      .populate({ path: "items.unit", select: "name abbreviation" })
      .sort({ createdAt: -1 });

    res.json(purchaseOrders);
  } catch (error) {
    console.error("Error fetching purchase orders:", error.message);
    res.status(500).json({ message: "Failed to fetch purchase orders" });
  }
};

export const getPurchaseOrderById = async (req, res) => {
  try {
    const { id } = req.params;
    const purchaseOrder = await PurchaseOrder.findById(id)
      .populate("supplier", "name phone email contactPerson isActive")
      .populate({ path: "location", select: "name code" })
      .populate("orderedBy", "fullName")
      .populate({ path: "items.inventoryItem", populate: { path: "unit", select: "name abbreviation" } })
      .populate({ path: "items.unit", select: "name abbreviation" });

    if (!purchaseOrder) return res.status(404).json({ message: "Purchase order not found" });
    res.json(purchaseOrder);
  } catch (error) {
    console.error("Error fetching purchase order:", error.message);
    res.status(500).json({ message: "Failed to fetch purchase order" });
  }
};

export const updatePurchaseOrder = async (req, res) => {
  try {
    const { id } = req.params;
    const purchaseOrder = await PurchaseOrder.findById(id);
    if (!purchaseOrder) return res.status(404).json({ message: "Purchase order not found" });

    if (["received", "cancelled"].includes(purchaseOrder.status)) {
      return res.status(400).json({ message: "Purchase order cannot be edited" });
    }

    if (purchaseOrder.status === "ordered") {
      return res.status(400).json({ message: "Ordered purchase orders cannot be edited" });
    }

    const { supplier, location, items, note } = req.body;
    const payload = { supplier: supplier ?? purchaseOrder.supplier, location: location ?? purchaseOrder.location, items: items ?? purchaseOrder.items };
    await validatePurchaseOrderPayload(payload);

    if (supplier !== undefined) purchaseOrder.supplier = supplier;
    if (location !== undefined) purchaseOrder.location = location;
    if (note !== undefined) purchaseOrder.note = note;
    if (items !== undefined) {
      purchaseOrder.items = items.map((item) => ({
        inventoryItem: item.inventoryItem,
        quantityOrdered: Number(item.quantityOrdered),
        quantityReceived: Number(item.quantityReceived ?? 0),
        unit: item.unit,
        costPerUnit: Number(item.costPerUnit),
        totalCost: Number(item.quantityOrdered) * Number(item.costPerUnit),
      }));
    }

    if (purchaseOrder.status === "partially_received" && purchaseOrder.items.some((item) => Number(item.quantityReceived) > Number(item.quantityOrdered))) {
      return res.status(400).json({ message: "Quantity received cannot exceed quantity ordered" });
    }

    await purchaseOrder.save();

    const populatedPurchaseOrder = await PurchaseOrder.findById(purchaseOrder._id)
      .populate("supplier", "name phone email contactPerson isActive")
      .populate({ path: "location", select: "name code" })
      .populate("orderedBy", "fullName")
      .populate({ path: "items.inventoryItem", populate: { path: "unit", select: "name abbreviation" } })
      .populate({ path: "items.unit", select: "name abbreviation" });

    res.json(populatedPurchaseOrder);
  } catch (error) {
    if (error.message === "Purchase order not found") {
      return res.status(404).json({ message: error.message });
    }
    if (error.message === "Purchase order cannot be edited") {
      return res.status(400).json({ message: error.message });
    }
    if (error.message === "Ordered purchase orders cannot be edited") {
      return res.status(400).json({ message: error.message });
    }
    if (error.message === "supplier is required") {
      return res.status(400).json({ message: error.message });
    }
    if (error.message === "location is required") {
      return res.status(400).json({ message: error.message });
    }
    if (error.message === "At least one item is required") {
      return res.status(400).json({ message: error.message });
    }
    if (error.message === "Supplier not found") {
      return res.status(404).json({ message: error.message });
    }
    if (error.message === "Supplier is not active") {
      return res.status(400).json({ message: error.message });
    }
    if (error.message === "Inventory location not found") {
      return res.status(404).json({ message: error.message });
    }
    if (error.message === "Inventory location is not active") {
      return res.status(400).json({ message: error.message });
    }
    if (error.message === "Each item requires an inventoryItem") {
      return res.status(400).json({ message: error.message });
    }
    if (error.message === "Each item requires a unit") {
      return res.status(400).json({ message: error.message });
    }
    if (error.message === "Each item quantity must be greater than 0") {
      return res.status(400).json({ message: error.message });
    }
    if (error.message === "Each item costPerUnit must be greater than or equal to 0") {
      return res.status(400).json({ message: error.message });
    }
    if (error.message === "Inventory item not found") {
      return res.status(404).json({ message: error.message });
    }
    if (error.message === "Inventory item is not active") {
      return res.status(400).json({ message: error.message });
    }
    if (error.message === "Unit not found") {
      return res.status(404).json({ message: error.message });
    }
    if (error.message === "Item unit must match the inventory item's configured unit") {
      return res.status(400).json({ message: error.message });
    }
    if (error.message === "Duplicate inventory item in purchase order") {
      return res.status(400).json({ message: error.message });
    }
    if (error.message === "Quantity received cannot exceed quantity ordered") {
      return res.status(400).json({ message: error.message });
    }
    console.error("Error updating purchase order:", error.message);
    res.status(500).json({ message: "Failed to update purchase order" });
  }
};

export const orderPurchaseOrder = async (req, res) => {
  try {
    const { id } = req.params;
    const purchaseOrder = await PurchaseOrder.findById(id);
    if (!purchaseOrder) return res.status(404).json({ message: "Purchase order not found" });
    if (purchaseOrder.status === "cancelled") return res.status(400).json({ message: "Purchase order is cancelled" });
    if (purchaseOrder.status === "received") return res.status(400).json({ message: "Purchase order is already received" });
    if (!purchaseOrder.items || purchaseOrder.items.length === 0) return res.status(400).json({ message: "Purchase order has no items" });

    purchaseOrder.status = "ordered";
    await purchaseOrder.save();

    const populatedPurchaseOrder = await PurchaseOrder.findById(purchaseOrder._id)
      .populate("supplier", "name phone email contactPerson isActive")
      .populate({ path: "location", select: "name code" })
      .populate("orderedBy", "fullName")
      .populate({ path: "items.inventoryItem", populate: { path: "unit", select: "name abbreviation" } })
      .populate({ path: "items.unit", select: "name abbreviation" });

    res.json(populatedPurchaseOrder);
  } catch (error) {
    console.error("Error ordering purchase order:", error.message);
    res.status(500).json({ message: "Failed to update purchase order status" });
  }
};

export const cancelPurchaseOrder = async (req, res) => {
  try {
    const { id } = req.params;
    const purchaseOrder = await PurchaseOrder.findById(id);
    if (!purchaseOrder) return res.status(404).json({ message: "Purchase order not found" });
    if (purchaseOrder.status === "received") return res.status(400).json({ message: "Purchase order is already received" });
    if (purchaseOrder.status === "cancelled") return res.status(400).json({ message: "Purchase order is already cancelled" });

    purchaseOrder.status = "cancelled";
    await purchaseOrder.save();

    const populatedPurchaseOrder = await PurchaseOrder.findById(purchaseOrder._id)
      .populate("supplier", "name phone email contactPerson isActive")
      .populate({ path: "location", select: "name code" })
      .populate("orderedBy", "fullName")
      .populate({ path: "items.inventoryItem", populate: { path: "unit", select: "name abbreviation" } })
      .populate({ path: "items.unit", select: "name abbreviation" });

    res.json(populatedPurchaseOrder);
  } catch (error) {
    console.error("Error cancelling purchase order:", error.message);
    res.status(500).json({ message: "Failed to cancel purchase order" });
  }
};

const validateWastePayload = async (payload) => {
  const { item, location, quantity, unit, reason } = payload;

  if (!item) {
    throw new Error("item is required");
  }

  if (!location) {
    throw new Error("location is required");
  }

  if (!unit) {
    throw new Error("unit is required");
  }

  if (!quantity || Number(quantity) <= 0) {
    throw new Error("quantity must be greater than 0");
  }

  if (!reason) {
    throw new Error("reason is required");
  }

  const inventoryItem = await InventoryItem.findById(item);
  if (!inventoryItem) {
    throw new Error("Inventory item not found");
  }
  if (!inventoryItem.isActive) {
    throw new Error("Inventory item is not active");
  }

  const locationDoc = await InventoryLocation.findById(location);
  if (!locationDoc) {
    throw new Error("Inventory location not found");
  }
  if (!locationDoc.isActive) {
    throw new Error("Inventory location is not active");
  }

  const unitDoc = await InventoryUnit.findById(unit);
  if (!unitDoc) {
    throw new Error("Unit not found");
  }

  if (String(inventoryItem.unit) !== String(unit)) {
    throw new Error("Item unit must match the inventory item's configured unit");
  }

  const validReasons = ["damaged", "spoiled", "expired", "spillage", "other"];
  if (!validReasons.includes(reason)) {
    throw new Error("Invalid waste reason");
  }

  return { inventoryItem, locationDoc, unitDoc };
};

export const createWaste = async (req, res) => {
  try {
    const { item, quantity, unit, reason, note, batch: requestedBatch } = req.body;
    requireInventoryIds(req.body, [["item", "inventory item"], ["location", "location"], ["unit", "unit"], ["batch", "batch"]]);
    const resolvedLocation = await resolveInventoryLocation(req.body.location, "Store");
    const location = resolvedLocation._id;
    const payload = { item, location, quantity, unit, reason };
    const { inventoryItem, locationDoc } = await validateWastePayload(payload);

    const normalizedQuantity = Number(quantity);
    const costPerUnit = Number(inventoryItem.costPerUnit || 0);
    const totalValue = normalizedQuantity * costPerUnit;

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      let stockBalance = await InventoryStock.findOne({ item, location }).session(session);
      if (!stockBalance) {
        stockBalance = await InventoryStock.create([{ item, location, quantity: 0 }], { session });
        stockBalance = stockBalance[0];
      }

      if (stockBalance.quantity < normalizedQuantity || inventoryItem.currentStock < normalizedQuantity) {
        throw new Error("Insufficient stock");
      }

      let allocation;
      if (requestedBatch) {
        const batch = await InventoryBatch.findById(requestedBatch).session(session);
        if (!batch || String(batch.inventoryItem) !== String(item) || String(batch.location) !== String(location) || batch.status === "cancelled" || Number(batch.quantity) < normalizedQuantity) {          throw new Error("Selected batch does not have enough usable stock");
        }
        batch.quantity -= normalizedQuantity;
        batch.status = getBatchStatus(batch);
        await batch.save({ session });
        allocation = { batchUsage: [{ batch: batch._id, quantityConsumed: normalizedQuantity }], legacyQuantityConsumed: 0 };
      } else {
        allocation = await consumeBatchesForQuantity({ inventoryItemId: item, locationId: location, requiredQuantity: normalizedQuantity, stockBalance, session, includeExpired: true });      }

      stockBalance.quantity -= normalizedQuantity;
      await stockBalance.save({ session });

      inventoryItem.currentStock -= normalizedQuantity;
      await inventoryItem.save({ session });

      const waste = await InventoryWaste.create(
        [{
          item,
          location,
          quantity: normalizedQuantity,
          unit,
          reason,
          costPerUnit,
          totalValue,
          recordedBy: req.user._id,
          note: note || "",
          status: "recorded",
          batch: allocation.batchUsage[0]?.batch,
          batchUsage: allocation.batchUsage,
          legacyQuantityConsumed: allocation.legacyQuantityConsumed,
        }],
        { session }
      );

      await InventoryUsageLog.create(
        [{
          item,
          location: locationDoc._id,
          quantity: normalizedQuantity,
          reason: "waste",
          costPerUnit,
          totalValue,
          recordedBy: req.user._id,
          note: note || `Waste recorded for ${reason}`,
          batchUsage: allocation.batchUsage,
          legacyQuantityConsumed: allocation.legacyQuantityConsumed,
        }],
        { session }
      );

      await session.commitTransaction();
      session.endSession();

      const populatedWaste = await InventoryWaste.findById(waste[0]._id)
        .populate({ path: "item", populate: { path: "unit", select: "name abbreviation" } })
        .populate({ path: "unit", select: "name abbreviation" })
        .populate({ path: "location", select: "name code" })
        .populate("recordedBy", "fullName");

      res.status(201).json(populatedWaste);
    } catch (error) {
      await session.abortTransaction();
      session.endSession();
      throw error;
    }
  } catch (error) {
    if (error.message === "item is required") {
      return res.status(400).json({ message: error.message });
    }
    if (error.message === "location is required") {
      return res.status(400).json({ message: error.message });
    }
    if (error.message === "unit is required") {
      return res.status(400).json({ message: error.message });
    }
    if (error.message === "quantity must be greater than 0") {
      return res.status(400).json({ message: error.message });
    }
    if (error.message === "reason is required") {
      return res.status(400).json({ message: error.message });
    }
    if (error.message === "Inventory item not found") {
      return res.status(404).json({ message: error.message });
    }
    if (error.message === "Inventory item is not active") {
      return res.status(400).json({ message: error.message });
    }
    if (error.message === "Inventory location not found") {
      return res.status(404).json({ message: error.message });
    }
    if (error.message === "Inventory location is not active") {
      return res.status(400).json({ message: error.message });
    }
    if (error.message === "Unit not found") {
      return res.status(404).json({ message: error.message });
    }
    if (error.message === "Item unit must match the inventory item's configured unit") {
      return res.status(400).json({ message: error.message });
    }
    if (error.message === "Invalid waste reason") {
      return res.status(400).json({ message: error.message });
    }
    if (error.message === "Insufficient stock") {
      return res.status(400).json({ message: error.message });
    }
    console.error("Error creating waste record:", error.message);
    res.status(500).json({ message: "Failed to create waste record" });
  }
};

export const getWastes = async (req, res) => {
  try {
    const wastes = await InventoryWaste.find()
      .populate({ path: "item", populate: { path: "unit", select: "name abbreviation" } })
      .populate({ path: "unit", select: "name abbreviation" })
      .populate({ path: "location", select: "name code" })
      .populate("recordedBy", "fullName")
      .sort({ createdAt: -1 });

    res.json(wastes);
  } catch (error) {
    console.error("Error fetching waste records:", error.message);
    res.status(500).json({ message: "Failed to fetch waste records" });
  }
};

export const getWasteById = async (req, res) => {
  try {
    const { id } = req.params;
    requireObjectId(id, "waste");
    const waste = await InventoryWaste.findById(id)
      .populate({ path: "item", populate: { path: "unit", select: "name abbreviation" } })
      .populate({ path: "unit", select: "name abbreviation" })
      .populate({ path: "location", select: "name code" })
      .populate("recordedBy", "fullName");

    if (!waste) {
      return res.status(404).json({ message: "Waste record not found" });
    }

    res.json(waste);
  } catch (error) {
    console.error("Error fetching waste record:", error.message);
    res.status(500).json({ message: "Failed to fetch waste record" });
  }
};

export const cancelWaste = async (req, res) => {
  try {
    const { id } = req.params;
    const waste = await InventoryWaste.findById(id);

    if (!waste) {
      return res.status(404).json({ message: "Waste record not found" });
    }

    if (waste.status === "cancelled") {
      return res.status(400).json({ message: "Waste record is already cancelled" });
    }

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const inventoryItem = await InventoryItem.findById(waste.item).session(session);
      if (!inventoryItem) {
        throw new Error("Inventory item not found");
      }

      const stockBalance = await InventoryStock.findOne({ item: waste.item, location: waste.location }).session(session);
      if (!stockBalance) {
        throw new Error("Inventory stock balance not found");
      }

      await initializeUnbatchedQuantity(stockBalance, session);
      stockBalance.quantity += waste.quantity;
      await restoreConsumptionPlan({ stockBalance, batchUsage: waste.batchUsage, legacyQuantityConsumed: waste.legacyQuantityConsumed, session });
      await stockBalance.save({ session });

      inventoryItem.currentStock += waste.quantity;
      await inventoryItem.save({ session });

      waste.status = "cancelled";
      await waste.save({ session });

      await InventoryUsageLog.create(
        [{
          item: waste.item,
          location: waste.location,
          quantity: waste.quantity,
          reason: "waste",
          costPerUnit: waste.costPerUnit,
          totalValue: waste.totalValue,
          recordedBy: req.user._id,
          note: `Waste reversal for ${waste._id}`,
          batchUsage: waste.batchUsage,
          legacyQuantityConsumed: waste.legacyQuantityConsumed,
        }],
        { session }
      );

      await session.commitTransaction();
      session.endSession();

      const populatedWaste = await InventoryWaste.findById(waste._id)
        .populate({ path: "item", populate: { path: "unit", select: "name abbreviation" } })
        .populate({ path: "unit", select: "name abbreviation" })
        .populate({ path: "location", select: "name code" })
        .populate("recordedBy", "fullName");

      res.json(populatedWaste);
    } catch (error) {
      await session.abortTransaction();
      session.endSession();
      throw error;
    }
  } catch (error) {
    if (error.message === "Inventory item not found") {
      return res.status(404).json({ message: error.message });
    }
    if (error.message === "Inventory stock balance not found") {
      return res.status(404).json({ message: error.message });
    }
    console.error("Error cancelling waste record:", error.message);
    res.status(500).json({ message: "Failed to cancel waste record" });
  }
};

/* =================================================
   UNITS — admin-defined measurement units
================================================= */
const validateProductionPayload = async (payload) => {
  const { producedItem, quantityProduced, unit, ingredientsUsed } = payload;

  if (!producedItem) {
    throw new Error("producedItem is required");
  }

  if (!quantityProduced || Number(quantityProduced) <= 0) {
    throw new Error("quantityProduced must be greater than 0");
  }

  if (!unit) {
    throw new Error("unit is required");
  }

  if (!Array.isArray(ingredientsUsed) || ingredientsUsed.length === 0) {
    throw new Error("At least one ingredient is required");
  }

  const producedItemDoc = await InventoryItem.findById(producedItem);
  if (!producedItemDoc) {
    throw new Error("Produced item not found");
  }

  const producedUnit = await InventoryUnit.findById(unit);
  if (!producedUnit) {
    throw new Error("Unit not found");
  }

  if (String(producedItemDoc.unit) !== String(unit)) {
    throw new Error("Produced item unit must match the provided unit");
  }

  const seenIngredients = new Set();

  for (const ingredient of ingredientsUsed) {
    if (!ingredient.inventoryItem) {
      throw new Error("Each ingredient requires an inventoryItem");
    }
    if (!ingredient.unit) {
      throw new Error("Each ingredient requires a unit");
    }
    if (!ingredient.quantityUsed || Number(ingredient.quantityUsed) <= 0) {
      throw new Error("Each ingredient quantity must be greater than 0");
    }

    const inventoryItem = await InventoryItem.findById(ingredient.inventoryItem);
    if (!inventoryItem) {
      throw new Error("Ingredient inventory item not found");
    }

    const ingredientUnit = await InventoryUnit.findById(ingredient.unit);
    if (!ingredientUnit) {
      throw new Error("Ingredient unit not found");
    }

    if (String(inventoryItem.unit) !== String(ingredient.unit)) {
      throw new Error("Ingredient unit must match the inventory item's configured unit");
    }

    const key = String(ingredient.inventoryItem);
    if (seenIngredients.has(key)) {
      throw new Error("Duplicate inventory item in production");
    }
    seenIngredients.add(key);
  }

  return { producedItemDoc };
};

export const createProduction = async (req, res) => {
  try {
    const { producedItem, menuItem, recipe, quantityProduced, unit, ingredientsUsed, location, note, status, batchNumber, manufacturingDate, expiryDate } = req.body;
    requireInventoryIds(req.body, [["producedItem", "produced item"], ["menuItem", "menu item"], ["recipe", "recipe"], ["unit", "unit"], ["location", "location"]]);
    for (const ingredient of ingredientsUsed || []) requireInventoryIds(ingredient, [["inventoryItem", "inventory item"], ["unit", "unit"]]);

    const payload = { producedItem, quantityProduced, unit, ingredientsUsed };
    const { producedItemDoc } = await validateProductionPayload(payload);

    const productionStatus = status || "completed";
    if (productionStatus === "cancelled") {
      return res.status(400).json({ message: "Production cannot be created with cancelled status" });
    }

    const productionLocation = await resolveInventoryLocation(location, "Store");
    let production;

    if (productionStatus === "completed") {
      const session = await mongoose.startSession();
      session.startTransaction();

      try {
        const ingredientUsageEntries = [];
        for (const ingredient of ingredientsUsed) {
          const inventoryItem = await InventoryItem.findById(ingredient.inventoryItem).session(session);
          if (!inventoryItem) {
            throw new Error("Ingredient inventory item not found");
          }

          let balanceDoc = await InventoryStock.findOne({ item: ingredient.inventoryItem, location: productionLocation._id }).session(session);
          if (!balanceDoc) {
            balanceDoc = await InventoryStock.create([{ item: ingredient.inventoryItem, location: productionLocation._id, quantity: 0 }], { session });
            balanceDoc = balanceDoc[0];
          }

          const quantityUsed = Number(ingredient.quantityUsed);
          if (balanceDoc.quantity < quantityUsed || inventoryItem.currentStock < quantityUsed) {
            throw new Error(`Insufficient stock for ${inventoryItem.name}`);
          }

          const costPerUnit = inventoryItem.costPerUnit || 0;
          const batchConsumption = await consumeBatchesForQuantity({
            inventoryItemId: ingredient.inventoryItem,
            locationId: productionLocation._id,
            requiredQuantity: quantityUsed,
            stockBalance: balanceDoc,
            session,
          });

          ingredientUsageEntries.push({
            inventoryItem: ingredient.inventoryItem,
            quantityUsed,
            unit: ingredient.unit,
            costPerUnit,
            totalCost: quantityUsed * costPerUnit,
            batchUsage: batchConsumption.batchUsage,
            legacyQuantityConsumed: batchConsumption.legacyQuantityConsumed,
          });
        }

        for (const ingredient of ingredientUsageEntries) {
          const inventoryItem = await InventoryItem.findById(ingredient.inventoryItem).session(session);
          if (!inventoryItem) {
            throw new Error("Ingredient inventory item not found");
          }

          let balanceDoc = await InventoryStock.findOne({ item: ingredient.inventoryItem, location: productionLocation._id }).session(session);
          if (!balanceDoc) {
            balanceDoc = await InventoryStock.create([{ item: ingredient.inventoryItem, location: productionLocation._id, quantity: 0 }], { session });
            balanceDoc = balanceDoc[0];
          }

          balanceDoc.quantity -= ingredient.quantityUsed;
          await balanceDoc.save({ session });

          inventoryItem.currentStock -= ingredient.quantityUsed;
          await inventoryItem.save({ session });

          await InventoryUsageLog.create(
            [{
              item: inventoryItem._id,
              quantity: ingredient.quantityUsed,
              reason: "used",
              costPerUnit: ingredient.costPerUnit,
              totalValue: ingredient.totalCost,
              recordedBy: req.user._id,
              note: `Production ${productionStatus}`,
            }],
            { session }
          );
        }

        let producedBalanceDoc = await InventoryStock.findOne({ item: producedItem, location: productionLocation._id }).session(session);
        if (!producedBalanceDoc) {
          producedBalanceDoc = await InventoryStock.create([{ item: producedItem, location: productionLocation._id, quantity: 0 }], { session });
          producedBalanceDoc = producedBalanceDoc[0];
        }

        producedBalanceDoc.quantity += Number(quantityProduced);
        await producedBalanceDoc.save({ session });

        producedItemDoc.currentStock += Number(quantityProduced);
        await producedItemDoc.save({ session });

        const parsedManufacturingDate = manufacturingDate ? new Date(manufacturingDate) : new Date();
        const parsedExpiryDate = expiryDate ? new Date(expiryDate) : undefined;
        if (Number.isNaN(parsedManufacturingDate.getTime()) || (parsedExpiryDate && Number.isNaN(parsedExpiryDate.getTime())) || (parsedExpiryDate && parsedExpiryDate < parsedManufacturingDate)) {
          throw new Error("Invalid production batch dates");
        }
        const totalIngredientCost = ingredientUsageEntries.reduce((sum, ingredient) => sum + Number(ingredient.totalCost), 0);
        const outputCostPerUnit = totalIngredientCost / Number(quantityProduced);
        const outputBatchNumber = await buildBatchNumber(producedItem, productionLocation._id, batchNumber, session);
        const producedBatch = await InventoryBatch.create([{
          batchNumber: outputBatchNumber, inventoryItem: producedItem, location: productionLocation._id,
          quantity: Number(quantityProduced), unit, costPerUnit: outputCostPerUnit,
          manufacturingDate: parsedManufacturingDate, expiryDate: parsedExpiryDate, status: "active", note: note || "",
        }], { session });

        production = await Production.create([
          {
            producedItem,
            menuItem,
            recipe,
            quantityProduced: Number(quantityProduced),
            unit,
            location: productionLocation._id,
            ingredientsUsed: ingredientUsageEntries,
            producedBy: req.user._id,
            note: note || "",
            status: "completed",
            producedBatch: producedBatch[0]._id,
          },
        ], { session });
        production = production[0];
        producedBatch[0].production = production._id;
        await producedBatch[0].save({ session });

        await session.commitTransaction();
        session.endSession();
      } catch (error) {
        await session.abortTransaction();
        session.endSession();
        throw error;
      }
    } else {
      production = await Production.create({
        producedItem,
        menuItem,
        recipe,
        quantityProduced: Number(quantityProduced),
        unit,
        location: productionLocation._id,
        ingredientsUsed: ingredientsUsed.map((ingredient) => ({
          inventoryItem: ingredient.inventoryItem,
          quantityUsed: Number(ingredient.quantityUsed),
          unit: ingredient.unit,
          costPerUnit: 0,
          totalCost: 0,
        })),
        producedBy: req.user._id,
        note: note || "",
        status: productionStatus,
      });
    }

    const populatedProduction = await Production.findById(production._id)
      .populate({ path: "producedItem", populate: { path: "unit", select: "name abbreviation" } })
      .populate({ path: "ingredientsUsed.inventoryItem", populate: { path: "unit", select: "name abbreviation" } })
      .populate({ path: "ingredientsUsed.unit", select: "name abbreviation" })
      .populate({ path: "unit", select: "name abbreviation" })
      .populate({ path: "location", select: "name code" })
      .populate("producedBy", "fullName")
      .populate("menuItem", "name")
      .populate("recipe", "note");

    res.status(201).json(populatedProduction);
  } catch (error) {
    if (error.message === "producedItem is required") {
      return res.status(400).json({ message: error.message });
    }
    if (error.message === "quantityProduced must be greater than 0") {
      return res.status(400).json({ message: error.message });
    }
    if (error.message === "unit is required") {
      return res.status(400).json({ message: error.message });
    }
    if (error.message === "At least one ingredient is required") {
      return res.status(400).json({ message: error.message });
    }
    if (error.message === "Produced item not found") {
      return res.status(404).json({ message: error.message });
    }
    if (error.message === "Unit not found") {
      return res.status(404).json({ message: error.message });
    }
    if (error.message === "Produced item unit must match the provided unit") {
      return res.status(400).json({ message: error.message });
    }
    if (error.message === "Each ingredient requires an inventoryItem") {
      return res.status(400).json({ message: error.message });
    }
    if (error.message === "Each ingredient requires a unit") {
      return res.status(400).json({ message: error.message });
    }
    if (error.message === "Each ingredient quantity must be greater than 0") {
      return res.status(400).json({ message: error.message });
    }
    if (error.message === "Ingredient inventory item not found") {
      return res.status(404).json({ message: error.message });
    }
    if (error.message === "Ingredient unit not found") {
      return res.status(404).json({ message: error.message });
    }
    if (error.message === "Ingredient unit must match the inventory item's configured unit") {
      return res.status(400).json({ message: error.message });
    }
    if (error.message === "Duplicate inventory item in production") {
      return res.status(400).json({ message: error.message });
    }
    if (error.message === "Inventory location not found" || error.message.includes("Default location")) {
      return res.status(404).json({ message: error.message });
    }
    console.error("Error creating production:", error.message);
    res.status(500).json({ message: "Failed to create production" });
  }
};

export const getProductions = async (req, res) => {
  try {
    const { status } = req.query;
    const filter = {};
    if (status) filter.status = status;

    const productions = await Production.find(filter)
      .populate({ path: "producedItem", populate: { path: "unit", select: "name abbreviation" } })
      .populate({ path: "ingredientsUsed.inventoryItem", populate: { path: "unit", select: "name abbreviation" } })
      .populate({ path: "ingredientsUsed.unit", select: "name abbreviation" })
      .populate({ path: "unit", select: "name abbreviation" })
      .populate({ path: "location", select: "name code" })
      .populate("producedBy", "fullName")
      .populate("menuItem", "name")
      .populate("recipe", "note")
      .sort({ createdAt: -1 });

    res.json(productions);
  } catch (error) {
    console.error("Error fetching productions:", error.message);
    res.status(500).json({ message: "Failed to fetch productions" });
  }
};

export const getProductionById = async (req, res) => {
  try {
    const { id } = req.params;
    const production = await Production.findById(id)
      .populate({ path: "producedItem", populate: { path: "unit", select: "name abbreviation" } })
      .populate({ path: "ingredientsUsed.inventoryItem", populate: { path: "unit", select: "name abbreviation" } })
      .populate({ path: "ingredientsUsed.unit", select: "name abbreviation" })
      .populate({ path: "unit", select: "name abbreviation" })
      .populate({ path: "location", select: "name code" })
      .populate("producedBy", "fullName")
      .populate("menuItem", "name")
      .populate("recipe", "note");

    if (!production) {
      return res.status(404).json({ message: "Production not found" });
    }

    res.json(production);
  } catch (error) {
    console.error("Error fetching production:", error.message);
    res.status(500).json({ message: "Failed to fetch production" });
  }
};

export const cancelProduction = async (req, res) => {
  try {
    const { id } = req.params;
    const production = await Production.findById(id);

    if (!production) {
      return res.status(404).json({ message: "Production not found" });
    }

    if (production.status === "cancelled") {
      return res.status(400).json({ message: "Production is already cancelled" });
    }

    if (production.status === "completed") {
      const session = await mongoose.startSession();
      session.startTransaction();

      try {
        for (const ingredient of production.ingredientsUsed) {
          const inventoryItem = await InventoryItem.findById(ingredient.inventoryItem).session(session);
          if (!inventoryItem) {
            throw new Error("Ingredient inventory item not found");
          }

          const balanceDoc = await InventoryStock.findOne({ item: ingredient.inventoryItem, location: production.location }).session(session);
          if (!balanceDoc) {
            throw new Error("Ingredient stock balance not found");
          }

          await initializeUnbatchedQuantity(balanceDoc, session);
          balanceDoc.quantity += ingredient.quantityUsed;
          await balanceDoc.save({ session });

          inventoryItem.currentStock += ingredient.quantityUsed;
          await inventoryItem.save({ session });

          if (Array.isArray(ingredient.batchUsage)) {
            await restoreConsumptionPlan({ stockBalance: balanceDoc, batchUsage: ingredient.batchUsage, legacyQuantityConsumed: ingredient.legacyQuantityConsumed, session });
          }
        }

        const producedItemDoc = await InventoryItem.findById(production.producedItem).session(session);
        if (!producedItemDoc) {
          throw new Error("Produced item not found");
        }

        const producedBalanceDoc = await InventoryStock.findOne({ item: production.producedItem, location: production.location }).session(session);
        if (!producedBalanceDoc) {
          throw new Error("Produced item stock balance not found");
        }

        if (producedBalanceDoc.quantity < production.quantityProduced) {
          throw new Error("Cannot cancel production because produced stock would become negative");
        }

        producedBalanceDoc.quantity -= production.quantityProduced;
        await producedBalanceDoc.save({ session });

        producedItemDoc.currentStock -= production.quantityProduced;
        await producedItemDoc.save({ session });

        if (production.producedBatch) {
          const producedBatch = await InventoryBatch.findById(production.producedBatch).session(session);
          if (!producedBatch || Number(producedBatch.quantity) < Number(production.quantityProduced)) {
            throw new Error("Cannot cancel production because produced batch stock was used");
          }
          producedBatch.quantity -= Number(production.quantityProduced);
          producedBatch.status = "cancelled";
          await producedBatch.save({ session });
        }

        production.status = "cancelled";
        await production.save({ session });

        await session.commitTransaction();
        session.endSession();
      } catch (error) {
        await session.abortTransaction();
        session.endSession();
        throw error;
      }
    }

    production.status = "cancelled";
    await production.save();

    const populatedProduction = await Production.findById(production._id)
      .populate({ path: "producedItem", populate: { path: "unit", select: "name abbreviation" } })
      .populate({ path: "ingredientsUsed.inventoryItem", populate: { path: "unit", select: "name abbreviation" } })
      .populate({ path: "ingredientsUsed.unit", select: "name abbreviation" })
      .populate({ path: "unit", select: "name abbreviation" })
      .populate({ path: "location", select: "name code" })
      .populate("producedBy", "fullName")
      .populate("menuItem", "name")
      .populate("recipe", "note");

    res.json(populatedProduction);
  } catch (error) {
    if (error.message === "Ingredient inventory item not found") {
      return res.status(404).json({ message: error.message });
    }
    if (error.message === "Produced item not found") {
      return res.status(404).json({ message: error.message });
    }
    if (error.message === "Ingredient stock balance not found") {
      return res.status(404).json({ message: error.message });
    }
    if (error.message === "Produced item stock balance not found") {
      return res.status(404).json({ message: error.message });
    }
    if (error.message === "Cannot cancel production because produced stock would become negative") {
      return res.status(400).json({ message: error.message });
    }
    console.error("Error cancelling production:", error.message);
    res.status(500).json({ message: "Failed to cancel production" });
  }
};

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
   LOCATIONS — physical inventory locations
================================================= */

// @desc    Get all inventory locations
// @route   GET /api/inventory/locations
// @access  Protected — admin, accountant
export const getLocations = async (req, res) => {
  try {
    const locations = await InventoryLocation.find().sort({ name: 1 });
    res.json(locations);
  } catch (error) {
    console.error("Error fetching inventory locations:", error.message);
    res.status(500).json({ message: "Failed to fetch inventory locations" });
  }
};

// @desc    Create an inventory location
// @route   POST /api/inventory/locations
// @access  Protected — admin
export const createLocation = async (req, res) => {
  try {
    const { name, code } = req.body;
    if (!name || !code) {
      return res.status(400).json({ message: "Name and code are required" });
    }

    const location = await InventoryLocation.create({
      name: name.trim(),
      code: code.trim().toUpperCase(),
    });

    res.status(201).json(location);
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(400).json({ message: "Location name or code already exists" });
    }
    console.error("Error creating inventory location:", error.message);
    res.status(500).json({ message: "Failed to create inventory location" });
  }
};

// @desc    Update an inventory location
// @route   PUT /api/inventory/locations/:id
// @access  Protected — admin
export const updateLocation = async (req, res) => {
  try {
    const { id } = req.params;
    const updates = {};

    if (req.body.name !== undefined) updates.name = req.body.name.trim();
    if (req.body.code !== undefined) updates.code = req.body.code.trim().toUpperCase();
    if (req.body.isActive !== undefined) updates.isActive = req.body.isActive;

    if (!Object.keys(updates).length) {
      return res.status(400).json({ message: "No valid update fields provided" });
    }

    const location = await InventoryLocation.findByIdAndUpdate(id, updates, {
      new: true,
      runValidators: true,
    });

    if (!location) return res.status(404).json({ message: "Inventory location not found" });
    res.json(location);
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(400).json({ message: "Location name or code already exists" });
    }
    console.error("Error updating inventory location:", error.message);
    res.status(500).json({ message: "Failed to update inventory location" });
  }
};

// @desc    Deactivate an inventory location
// @route   DELETE /api/inventory/locations/:id
// @access  Protected — admin
export const deleteLocation = async (req, res) => {
  try {
    const { id } = req.params;
    const location = await InventoryLocation.findByIdAndUpdate(id, { isActive: false }, { new: true });

    if (!location) return res.status(404).json({ message: "Inventory location not found" });
    res.json({ message: "Location deactivated", location });
  } catch (error) {
    console.error("Error deactivating inventory location:", error.message);
    res.status(500).json({ message: "Failed to deactivate inventory location" });
  }
};

/* =================================================
   LOCATION STOCK — balances per item per location
================================================= */

// @desc    Get stock balances for a specific location
// @route   GET /api/inventory/stock/locations/:locationId
// @access  Protected — admin, accountant
export const getLocationStock = async (req, res) => {
  try {
    const { locationId } = req.params;
    const balances = await InventoryStock.find({ location: locationId })
      .populate({ path: "item", populate: { path: "unit", select: "name abbreviation" } })
      .populate("location", "name code")
      .sort({ createdAt: -1 });

    res.json(balances);
  } catch (error) {
    console.error("Error fetching location stock:", error.message);
    res.status(500).json({ message: "Failed to fetch location stock" });
  }
};

// @desc    Get all location balances for a specific inventory item
// @route   GET /api/inventory/stock/items/:itemId
// @access  Protected — admin, accountant
export const getItemLocationStock = async (req, res) => {
  try {
    const { itemId } = req.params;
    const balances = await InventoryStock.find({ item: itemId })
      .populate({ path: "item", populate: { path: "unit", select: "name abbreviation" } })
      .populate("location", "name code")
      .sort({ createdAt: -1 });

    res.json(balances);
  } catch (error) {
    console.error("Error fetching item location stock:", error.message);
    res.status(500).json({ message: "Failed to fetch item location stock" });
  }
};

// @desc    Get all location-specific inventory stock balances
// @route   GET /api/inventory/stock/locations
// @access  Protected — admin, accountant
export const getAllLocationStock = async (req, res) => {
  try {
    const balances = await InventoryStock.find()
      .populate({ path: "item", populate: { path: "unit", select: "name abbreviation" } })
      .populate("location", "name code")
      .sort({ createdAt: -1 });

    res.json(balances);
  } catch (error) {
    console.error("Error fetching all location stock:", error.message);
    res.status(500).json({ message: "Failed to fetch all location stock" });
  }
};

/* =================================================
   TRANSFERS — move stock between locations
================================================= */

// @desc    Create an inventory transfer between locations
// @route   POST /api/inventory/transfers
// @access  Protected — admin
export const createTransfer = async (req, res) => {
  try {
    const { item: itemId, quantity, fromLocation, toLocation, note } = req.body;
    requireInventoryIds(req.body, [["item", "inventory item"], ["fromLocation", "source location"], ["toLocation", "destination location"]]);

    if (!itemId || !quantity || !fromLocation || !toLocation) {
      return res.status(400).json({ message: "item, quantity, fromLocation and toLocation are required" });
    }

    if (quantity <= 0) {
      return res.status(400).json({ message: "quantity must be greater than 0" });
    }

    if (fromLocation === toLocation) {
      return res.status(400).json({ message: "fromLocation and toLocation must be different" });
    }

    const item = await InventoryItem.findById(itemId);
    if (!item) return res.status(404).json({ message: "Inventory item not found" });

    const sourceLocation = await InventoryLocation.findById(fromLocation);
    const destinationLocation = await InventoryLocation.findById(toLocation);
    if (!sourceLocation || !destinationLocation) {
      return res.status(404).json({ message: "Inventory location not found" });
    }

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const sourceBalance = await ensureLocationStockBalance(itemId, sourceLocation._id, session);
      const destinationBalance = await ensureLocationStockBalance(itemId, destinationLocation._id, session);
      if (Number(sourceBalance.quantity) < Number(quantity)) throw new Error("Source location does not have enough stock");
      const allocation = await consumeBatchesForQuantity({ inventoryItemId: itemId, locationId: sourceLocation._id, requiredQuantity: Number(quantity), stockBalance: sourceBalance, session });
      sourceBalance.quantity -= quantity;
      destinationBalance.quantity += quantity;
      await sourceBalance.save({ session });
      await destinationBalance.save({ session });

      const batchTransfers = [];
      for (const usage of allocation.batchUsage) {
        const sourceBatch = await InventoryBatch.findById(usage.batch).session(session);
        let destinationBatch = await InventoryBatch.findOne({ inventoryItem: itemId, location: destinationLocation._id, batchNumber: sourceBatch.batchNumber }).session(session);
        if (!destinationBatch) {
          destinationBatch = (await InventoryBatch.create([{
            batchNumber: sourceBatch.batchNumber, inventoryItem: itemId, location: destinationLocation._id,
            quantity: 0, unit: sourceBatch.unit, costPerUnit: sourceBatch.costPerUnit,
            manufacturingDate: sourceBatch.manufacturingDate, expiryDate: sourceBatch.expiryDate,
            supplier: sourceBatch.supplier, status: "active", note: sourceBatch.note,
          }], { session }))[0];
        }
        destinationBatch.quantity += Number(usage.quantityConsumed);
        destinationBatch.status = getBatchStatus(destinationBatch);
        await destinationBatch.save({ session });
        batchTransfers.push({ batch: usage.batch, quantity: usage.quantityConsumed, destinationBatch: destinationBatch._id });
      }
      if (allocation.legacyQuantityConsumed) {
        await initializeUnbatchedQuantity(destinationBalance, session);
        destinationBalance.unbatchedQuantity += allocation.legacyQuantityConsumed;
        await destinationBalance.save({ session });
      }

      const transfer = await InventoryTransfer.create(
        [{
          item: itemId,
          quantity,
          fromLocation: sourceLocation._id,
          toLocation: destinationLocation._id,
          transferredBy: req.user._id,
          note: note || "",
          batchTransfers,
          legacyQuantity: allocation.legacyQuantityConsumed,
        }],
        { session }
      );

      await session.commitTransaction();
      session.endSession();

      const populatedTransfer = await InventoryTransfer.findById(transfer[0]._id)
        .populate({ path: "item", populate: { path: "unit", select: "name abbreviation" } })
        .populate("fromLocation", "name code")
        .populate("toLocation", "name code")
        .populate("transferredBy", "fullName");

      res.status(201).json(populatedTransfer);
    } catch (error) {
      await session.abortTransaction();
      session.endSession();
      throw error;
    }
  } catch (error) {
    if (error.message === "Source location does not have enough stock" || error.message === "Insufficient stock") return res.status(400).json({ message: error.message });
    console.error("Error creating inventory transfer:", error.message);
    res.status(500).json({ message: "Failed to create inventory transfer" });
  }
};

// @desc    Get inventory transfer history
// @route   GET /api/inventory/transfers
// @access  Protected — admin, accountant
export const getTransfers = async (req, res) => {
  try {
    const { item, fromLocation, toLocation } = req.query;
    const filter = {};
    if (item) filter.item = item;
    if (fromLocation) filter.fromLocation = fromLocation;
    if (toLocation) filter.toLocation = toLocation;

    const transfers = await InventoryTransfer.find(filter)
      .populate({ path: "item", populate: { path: "unit", select: "name abbreviation" } })
      .populate("fromLocation", "name code")
      .populate("toLocation", "name code")
      .populate("transferredBy", "fullName")
      .sort({ createdAt: -1 });

    res.json(transfers);
  } catch (error) {
    console.error("Error fetching inventory transfers:", error.message);
    res.status(500).json({ message: "Failed to fetch inventory transfers" });
  }
};

/* =================================================
   RECIPES — BOM / ingredient definitions for menu items
================================================= */

const validateRecipePayload = async (payload) => {
  const { menuItem, ingredients } = payload;

  if (!menuItem) {
    throw new Error("menuItem is required");
  }

  if (!Array.isArray(ingredients) || ingredients.length === 0) {
    throw new Error("At least one ingredient is required");
  }

  const menu = await MenuItem.findById(menuItem);
  if (!menu) {
    throw new Error("Menu item not found");
  }

  const seenInventoryItems = new Set();

  for (const ingredient of ingredients) {
    if (!ingredient.inventoryItem) {
      throw new Error("Each ingredient requires an inventoryItem");
    }
    if (!ingredient.unit) {
      throw new Error("Each ingredient requires a unit");
    }
    if (!ingredient.quantity || ingredient.quantity <= 0) {
      throw new Error("Each ingredient quantity must be greater than 0");
    }

    const inventoryItem = await InventoryItem.findById(ingredient.inventoryItem);
    if (!inventoryItem) {
      throw new Error("Inventory item not found");
    }

    if (seenInventoryItems.has(String(ingredient.inventoryItem))) {
      throw new Error("Duplicate inventory item in recipe");
    }
    seenInventoryItems.add(String(ingredient.inventoryItem));

    const unit = await InventoryUnit.findById(ingredient.unit);
    if (!unit) {
      throw new Error("Unit not found");
    }

    if (String(inventoryItem.unit) !== String(ingredient.unit)) {
      throw new Error("Ingredient unit must match the inventory item's configured unit");
    }
  }

  return { menu };
};

// @desc    Create a recipe for a menu item
// @route   POST /api/inventory/recipes
// @access  Protected — admin
export const createRecipe = async (req, res) => {
  try {
    const { menuItem, ingredients, note } = req.body;
    const payload = { menuItem, ingredients };
    await validateRecipePayload(payload);

    const existingRecipe = await Recipe.findOne({ menuItem, isActive: true });
    if (existingRecipe) {
      return res.status(400).json({ message: "An active recipe already exists for this menu item" });
    }

    const recipe = await Recipe.create({
      menuItem,
      ingredients,
      note: note || "",
      isActive: true,
    });

    const populatedRecipe = await Recipe.findById(recipe._id)
      .populate({ path: "menuItem", select: "name" })
      .populate({ path: "ingredients.inventoryItem", populate: { path: "unit", select: "name abbreviation" } })
      .populate("ingredients.unit", "name abbreviation");

    res.status(201).json(populatedRecipe);
  } catch (error) {
    if (error.message === "menuItem is required") {
      return res.status(400).json({ message: error.message });
    }
    if (error.message === "At least one ingredient is required") {
      return res.status(400).json({ message: error.message });
    }
    if (error.message === "Each ingredient requires an inventoryItem") {
      return res.status(400).json({ message: error.message });
    }
    if (error.message === "Each ingredient requires a unit") {
      return res.status(400).json({ message: error.message });
    }
    if (error.message === "Each ingredient quantity must be greater than 0") {
      return res.status(400).json({ message: error.message });
    }
    if (error.message === "Menu item not found") {
      return res.status(404).json({ message: error.message });
    }
    if (error.message === "Inventory item not found") {
      return res.status(404).json({ message: error.message });
    }
    if (error.message === "Unit not found") {
      return res.status(404).json({ message: error.message });
    }
    if (error.message === "Ingredient unit must match the inventory item's configured unit") {
      return res.status(400).json({ message: error.message });
    }
    if (error.message === "Duplicate inventory item in recipe") {
      return res.status(400).json({ message: error.message });
    }
    console.error("Error creating recipe:", error.message);
    res.status(500).json({ message: "Failed to create recipe" });
  }
};

// @desc    Get all recipes
// @route   GET /api/inventory/recipes
// @access  Protected — admin, accountant
export const getRecipes = async (req, res) => {
  try {
    const recipes = await Recipe.find({ isActive: true })
      .populate({ path: "menuItem", select: "name" })
      .populate({ path: "ingredients.inventoryItem", populate: { path: "unit", select: "name abbreviation" } })
      .populate("ingredients.unit", "name abbreviation")
      .sort({ createdAt: -1 });

    res.json(recipes);
  } catch (error) {
    console.error("Error fetching recipes:", error.message);
    res.status(500).json({ message: "Failed to fetch recipes" });
  }
};

// @desc    Get a recipe for a specific menu item
// @route   GET /api/inventory/recipes/:menuItemId
// @access  Protected — admin, accountant
export const getRecipeByMenuItem = async (req, res) => {
  try {
    const { menuItemId } = req.params;
    const recipe = await Recipe.findOne({ menuItem: menuItemId, isActive: true })
      .populate({ path: "menuItem", select: "name" })
      .populate({ path: "ingredients.inventoryItem", populate: { path: "unit", select: "name abbreviation" } })
      .populate("ingredients.unit", "name abbreviation");

    if (!recipe) return res.status(404).json({ message: "Recipe not found" });
    res.json(recipe);
  } catch (error) {
    console.error("Error fetching recipe:", error.message);
    res.status(500).json({ message: "Failed to fetch recipe" });
  }
};

// @desc    Update a recipe
// @route   PUT /api/inventory/recipes/:id
// @access  Protected — admin
export const updateRecipe = async (req, res) => {
  try {
    const { id } = req.params;
    const { menuItem, ingredients, note, isActive } = req.body;

    const recipe = await Recipe.findById(id);
    if (!recipe) return res.status(404).json({ message: "Recipe not found" });

    const payload = {
      menuItem: menuItem ?? recipe.menuItem,
      ingredients: ingredients ?? recipe.ingredients,
    };
    await validateRecipePayload(payload);

    if (menuItem && String(menuItem) !== String(recipe.menuItem)) {
      const existingRecipe = await Recipe.findOne({ menuItem, isActive: true });
      if (existingRecipe) {
        return res.status(400).json({ message: "An active recipe already exists for this menu item" });
      }
    }

    recipe.menuItem = menuItem ?? recipe.menuItem;
    recipe.ingredients = ingredients ?? recipe.ingredients;
    if (note !== undefined) recipe.note = note;
    if (isActive !== undefined) recipe.isActive = isActive;
    await recipe.save();

    const populatedRecipe = await Recipe.findById(recipe._id)
      .populate({ path: "menuItem", select: "name" })
      .populate({ path: "ingredients.inventoryItem", populate: { path: "unit", select: "name abbreviation" } })
      .populate("ingredients.unit", "name abbreviation");

    res.json(populatedRecipe);
  } catch (error) {
    if (error.message === "menuItem is required") {
      return res.status(400).json({ message: error.message });
    }
    if (error.message === "At least one ingredient is required") {
      return res.status(400).json({ message: error.message });
    }
    if (error.message === "Each ingredient requires an inventoryItem") {
      return res.status(400).json({ message: error.message });
    }
    if (error.message === "Each ingredient requires a unit") {
      return res.status(400).json({ message: error.message });
    }
    if (error.message === "Each ingredient quantity must be greater than 0") {
      return res.status(400).json({ message: error.message });
    }
    if (error.message === "Menu item not found") {
      return res.status(404).json({ message: error.message });
    }
    if (error.message === "Inventory item not found") {
      return res.status(404).json({ message: error.message });
    }
    if (error.message === "Unit not found") {
      return res.status(404).json({ message: error.message });
    }
    if (error.message === "Ingredient unit must match the inventory item's configured unit") {
      return res.status(400).json({ message: error.message });
    }
    if (error.message === "Duplicate inventory item in recipe") {
      return res.status(400).json({ message: error.message });
    }
    console.error("Error updating recipe:", error.message);
    res.status(500).json({ message: "Failed to update recipe" });
  }
};

// @desc    Deactivate a recipe
// @route   DELETE /api/inventory/recipes/:id
// @access  Protected — admin
export const deleteRecipe = async (req, res) => {
  try {
    const { id } = req.params;
    const recipe = await Recipe.findByIdAndUpdate(id, { isActive: false }, { new: true });
    if (!recipe) return res.status(404).json({ message: "Recipe not found" });
    res.json({ message: "Recipe deactivated", recipe });
  } catch (error) {
    console.error("Error deleting recipe:", error.message);
    res.status(500).json({ message: "Failed to deactivate recipe" });
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

// @desc    Create an inventory item
// @route   POST /api/inventory/items
// @access  Protected — admin
export const createItem = async (req, res) => {
  try {
    const { name, unit, category, costPerUnit, reorderLevel, itemType } = req.body;
    if (!name || !unit) {
      return res.status(400).json({ message: "Name and unit are required" });
    }
    const item = await InventoryItem.create({
      name,
      unit,
      itemType: itemType || "raw_material",
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
    const allowed = ["name", "unit", "category", "costPerUnit", "reorderLevel", "isActive", "itemType"];
    const updates = {};
    allowed.forEach((key) => {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    });

    if (!Object.keys(updates).length) {
      return res.status(400).json({ message: "No valid update fields provided" });
    }

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
    const { item: itemId, quantity, costPerUnit, note, locationId, batchNumber, manufacturingDate, expiryDate } = req.body;
    requireInventoryIds(req.body, [["item", "inventory item"], ["locationId", "location"]]);
    if (!itemId || !quantity || costPerUnit === undefined) {
      return res.status(400).json({ message: "item, quantity and costPerUnit are required" });
    }
    if (quantity <= 0) {
      return res.status(400).json({ message: "quantity must be greater than 0" });
    }

    const item = await InventoryItem.findById(itemId);
    if (!item) return res.status(404).json({ message: "Inventory item not found" });

    const location = await resolveInventoryLocation(locationId, "Store");
    const totalCost = quantity * costPerUnit;
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      const stockBalance = await ensureLocationStockBalance(itemId, location._id, session);
      stockBalance.quantity += Number(quantity);
      await stockBalance.save({ session });
      item.currentStock += Number(quantity);
      item.costPerUnit = costPerUnit;
      await item.save({ session });
      const parsedManufacturingDate = manufacturingDate ? new Date(manufacturingDate) : undefined;
      const parsedExpiryDate = expiryDate ? new Date(expiryDate) : undefined;
      if ((parsedManufacturingDate && Number.isNaN(parsedManufacturingDate.getTime())) || (parsedExpiryDate && Number.isNaN(parsedExpiryDate.getTime()))) throw new Error("Invalid batch date");
      const batch = (await InventoryBatch.create([{
        batchNumber: await buildBatchNumber(itemId, location._id, batchNumber, session), inventoryItem: itemId, location: location._id,
        quantity: Number(quantity), unit: item.unit, costPerUnit: Number(costPerUnit), manufacturingDate: parsedManufacturingDate, expiryDate: parsedExpiryDate,
        status: "active", note: note || "",
      }], { session }))[0];
      const entry = (await StockEntry.create([{ item: itemId, location: location._id, batch: batch._id, quantity, costPerUnit, totalCost, addedBy: req.user._id, note: note || "" }], { session }))[0];
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
    const { item: itemId, quantity, reason, note, locationId } = req.body;
    requireInventoryIds(req.body, [["item", "inventory item"], ["locationId", "location"]]);
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

    const location = await resolveInventoryLocation(locationId, "Store");    const totalValue = quantity * item.costPerUnit;
    const session = await mongoose.startSession(); session.startTransaction();
    try {
      const stockBalance = await ensureLocationStockBalance(itemId, location._id, session);
      if (Number(stockBalance.quantity) < Number(quantity) || Number(item.currentStock) < Number(quantity)) throw new Error("Insufficient stock");
      const allocation = await consumeBatchesForQuantity({ inventoryItemId: itemId, locationId: location._id, requiredQuantity: Number(quantity), stockBalance, session });
      stockBalance.quantity -= Number(quantity); await stockBalance.save({ session });
      item.currentStock -= Number(quantity); await item.save({ session });
      const log = (await InventoryUsageLog.create([{ item: itemId, location: location._id, quantity, reason: reason || "used", costPerUnit: item.costPerUnit, totalValue, recordedBy: req.user._id, note: note || "", batchUsage: allocation.batchUsage, legacyQuantityConsumed: allocation.legacyQuantityConsumed }], { session }))[0];
      await session.commitTransaction(); session.endSession();
      res.status(201).json({ log, item });
    } catch (error) { await session.abortTransaction(); session.endSession(); throw error; }
  } catch (error) {
    if (error.message === "Inventory location not found" || error.message.includes("Default location")) {
      return res.status(404).json({ message: error.message });
    }
    if (error.name === "Error") {
      // Everything we deliberately throw above is a plain Error with a
      // specific, safe message meant to be shown — pass it through instead
      // of hiding it behind a generic one.
      return res.status(400).json({ message: error.message });
    }
    console.error("Error logging usage:", error.message);
    res.status(500).json({ message: "Failed to log usage" });
  }
};

// @desc    Manually correct an item's stock (e.g. after a physical stock count)
// @route   POST /api/inventory/adjust
// @access  Protected — admin
export const adjustStock = async (req, res) => {
  try {
    const { item: itemId, delta, note, locationId } = req.body;
    requireInventoryIds(req.body, [["item", "inventory item"], ["locationId", "location"]]);
    if (!itemId || delta === undefined || delta === 0) {
      return res.status(400).json({ message: "item and a non-zero delta are required" });
    }

    const item = await InventoryItem.findById(itemId);
    if (!item) return res.status(404).json({ message: "Inventory item not found" });

    const location = await resolveInventoryLocation(locationId, "Store");
    const totalValue = delta * item.costPerUnit;
    const session = await mongoose.startSession(); session.startTransaction();
    try {
      const stockBalance = await ensureLocationStockBalance(itemId, location._id, session);
      let allocation = { batchUsage: [], legacyQuantityConsumed: 0 };
      if (Number(delta) < 0) {
        const requiredQuantity = Math.abs(Number(delta));
        if (Number(stockBalance.quantity) < requiredQuantity || Number(item.currentStock) < requiredQuantity) throw new Error("Location stock balance cannot be negative");
        allocation = await consumeBatchesForQuantity({ inventoryItemId: itemId, locationId: location._id, requiredQuantity, stockBalance, session });
      } else {
        await initializeUnbatchedQuantity(stockBalance, session);
        stockBalance.unbatchedQuantity += Number(delta);
      }
      stockBalance.quantity += Number(delta); await stockBalance.save({ session });
      item.currentStock += Number(delta); await item.save({ session });
      const log = (await InventoryUsageLog.create([{ item: itemId, location: location._id, quantity: delta, reason: "adjustment", costPerUnit: item.costPerUnit, totalValue, recordedBy: req.user._id, note: note || "", batchUsage: allocation.batchUsage, legacyQuantityConsumed: allocation.legacyQuantityConsumed }], { session }))[0];
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

/* =================================================
   USAGE REPORT — "since refill" view for admin + kitchen
================================================= */

// @desc    Get per-item usage totals (used/waste split) within a day window,
//          plus each item's last restock info (who filled it, when, how much)
// @route   GET /api/inventory/usage/overview?days=&search=
// @access  Protected — admin, kitchen
export const getUsageOverview = async (req, res) => {
  try {
    const { days = 1, search = "" } = req.query;
    const since = new Date(Date.now() - Number(days) * 24 * 60 * 60 * 1000);

    const itemFilter = req.user.isAdmin ? {} : { isActive: true };
    if (search) itemFilter.name = { $regex: search, $options: "i" };

    const items = await InventoryItem.find(itemFilter)
      .populate("unit", "name abbreviation")
      .sort({ name: 1 });

    if (items.length === 0) {
      return res.json({ since, days: Number(days), items: [] });
    }

    const itemIds = items.map((i) => i._id);

    // usage totals per item within the window, split by reason
    const usageAgg = await InventoryUsageLog.aggregate([
      {
        $match: {
          item: { $in: itemIds },
          reason: { $in: ["used", "waste"] },
          createdAt: { $gte: since },
        },
      },
      {
        $group: {
          _id: { item: "$item", reason: "$reason" },
          quantity: { $sum: "$quantity" },
          totalValue: { $sum: "$totalValue" },
        },
      },
    ]);

    // most recent restock per item, for "last refilled" context
    const lastRefills = await StockEntry.aggregate([
      { $match: { item: { $in: itemIds } } },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: "$item",
          quantity: { $first: "$quantity" },
          costPerUnit: { $first: "$costPerUnit" },
          addedBy: { $first: "$addedBy" },
          createdAt: { $first: "$createdAt" },
        },
      },
    ]);
    await StockEntry.populate(lastRefills, { path: "addedBy", select: "fullName" });

    const usageByItem = {};
    usageAgg.forEach((u) => {
      const key = String(u._id.item);
      if (!usageByItem[key]) {
        usageByItem[key] = {
          used: { quantity: 0, totalValue: 0 },
          waste: { quantity: 0, totalValue: 0 },
        };
      }
      usageByItem[key][u._id.reason] = { quantity: u.quantity, totalValue: u.totalValue };
    });

    const refillByItem = {};
    lastRefills.forEach((r) => {
      refillByItem[String(r._id)] = r;
    });

    const result = items.map((item) => {
      const usage = usageByItem[String(item._id)] || {
        used: { quantity: 0, totalValue: 0 },
        waste: { quantity: 0, totalValue: 0 },
      };
      const refill = refillByItem[String(item._id)] || null;

      return {
        item: {
          _id: item._id,
          name: item.name,
          category: item.category,
          unit: item.unit,
          currentStock: item.currentStock,
          costPerUnit: item.costPerUnit,
          isActive: item.isActive,
        },
        usedQuantity: usage.used.quantity,
        usedValue: usage.used.totalValue,
        wastedQuantity: usage.waste.quantity,
        wastedValue: usage.waste.totalValue,
        totalQuantity: usage.used.quantity + usage.waste.quantity,
        totalValue: usage.used.totalValue + usage.waste.totalValue,
        lastRefill: refill
          ? {
              date: refill.createdAt,
              quantity: refill.quantity,
              costPerUnit: refill.costPerUnit,
              filledBy: refill.addedBy?.fullName || "Unknown",
            }
          : null,
      };
    });

    // busiest items float to the top
    result.sort((a, b) => b.totalValue - a.totalValue);

    res.json({ since, days: Number(days), items: result });
  } catch (error) {
    console.error("Error fetching usage overview:", error.message);
    res.status(500).json({ message: "Failed to fetch usage overview" });
  }
};

// @desc    Get one-by-one usage log entries for a single item within a day window,
//          plus that item's last restock info
// @route   GET /api/inventory/usage/:itemId/detail?days=
// @access  Protected — admin, kitchen
export const getItemUsageDetail = async (req, res) => {
  try {
    const { itemId } = req.params;
    const { days = 1 } = req.query;
    const since = new Date(Date.now() - Number(days) * 24 * 60 * 60 * 1000);

    const item = await InventoryItem.findById(itemId).populate("unit", "name abbreviation");
    if (!item) return res.status(404).json({ message: "Inventory item not found" });

    const lastRefill = await StockEntry.findOne({ item: itemId })
      .sort({ createdAt: -1 })
      .populate("addedBy", "fullName");

    const logs = await InventoryUsageLog.find({
      item: itemId,
      reason: { $in: ["used", "waste"] },
      createdAt: { $gte: since },
    })
      .populate("recordedBy", "fullName")
      .sort({ createdAt: -1 });

    res.json({
      item: {
        _id: item._id,
        name: item.name,
        category: item.category,
        unit: item.unit,
        currentStock: item.currentStock,
      },
      since,
      days: Number(days),
      lastRefill: lastRefill
        ? {
            date: lastRefill.createdAt,
            quantity: lastRefill.quantity,
            costPerUnit: lastRefill.costPerUnit,
            filledBy: lastRefill.addedBy?.fullName || "Unknown",
          }
        : null,
      logs: logs.map((l) => ({
        _id: l._id,
        quantity: l.quantity,
        reason: l.reason,
        costPerUnit: l.costPerUnit,
        totalValue: l.totalValue,
        note: l.note,
        recordedBy: l.recordedBy?.fullName || "Unknown",
        createdAt: l.createdAt,
      })),
    });
  } catch (error) {
    console.error("Error fetching item usage detail:", error.message);
    res.status(500).json({ message: "Failed to fetch item usage detail" });
  }
};

/* =================================================
   BATCHES / INTEGRITY
================================================= */
export const getBatches = async (req, res) => {
  try {
    const { item, location, supplier, status, expiringBefore } = req.query;
    requireInventoryIds(req.query, [["item", "inventory item"], ["location", "location"], ["supplier", "supplier"]]);
    const filter = {};
    if (item) filter.inventoryItem = item;
    if (location) filter.location = location;
    if (supplier) filter.supplier = supplier;
    if (status) filter.status = status;
    if (expiringBefore) {
      const date = new Date(expiringBefore);
      if (Number.isNaN(date.getTime())) throw new Error("Invalid expiry date");
      filter.expiryDate = { $lte: date };
    }
    const batches = await InventoryBatch.find(filter)
      .populate("inventoryItem", "name unit")
      .populate("location", "name code")
      .populate("supplier", "name")
      .sort({ expiryDate: 1, createdAt: 1 });
    res.json(batches);
  } catch (error) {
    if (error.message.startsWith("Invalid ")) return res.status(400).json({ message: error.message });
    res.status(500).json({ message: "Failed to fetch batches" });
  }
};

export const getBatchById = async (req, res) => {
  try {
    requireObjectId(req.params.id, "batch");
    const batch = await InventoryBatch.findById(req.params.id)
      .populate({ path: "inventoryItem", populate: { path: "unit", select: "name abbreviation" } })
      .populate("location", "name code").populate("supplier", "name")
      .populate("receiving").populate("production");
    if (!batch) return res.status(404).json({ message: "Batch not found" });
    res.json(batch);
  } catch (error) {
    if (error.message.startsWith("Invalid ")) return res.status(400).json({ message: error.message });
    res.status(500).json({ message: "Failed to fetch batch" });
  }
};

export const getExpiringBatches = async (req, res) => {
  try {
    const days = Math.max(0, Number(req.query.days ?? 30));
    if (!Number.isFinite(days)) return res.status(400).json({ message: "days must be a number" });
    const now = new Date();
    const until = new Date(now.getTime() + days * 86400000);
    const batches = await InventoryBatch.find({ quantity: { $gt: 0 }, status: { $ne: "cancelled" }, expiryDate: { $lte: until } })
      .populate("inventoryItem", "name").populate("location", "name code").sort({ expiryDate: 1 });
    res.json({ now, until, batches });
  } catch (error) { res.status(500).json({ message: "Failed to fetch expiring batches" }); }
};

export const getInventoryIntegrity = async (req, res) => {
  try {
    const stocks = await InventoryStock.find().populate("item", "name").populate("location", "name code");
    const issues = [];
    const rows = [];
    for (const stock of stocks) {
      const batches = await InventoryBatch.find({ inventoryItem: stock.item._id, location: stock.location._id, status: { $ne: "cancelled" } }).select("quantity");
      const batchQuantity = batches.reduce((sum, batch) => sum + Number(batch.quantity), 0);
      const unbatchedQuantity = stock.unbatchedQuantity === undefined || stock.unbatchedQuantity === null ? null : Number(stock.unbatchedQuantity);
      const expected = unbatchedQuantity === null ? null : batchQuantity + unbatchedQuantity;
      const variance = expected === null ? null : Number(stock.quantity) - expected;
      const row = { item: stock.item, location: stock.location, quantity: stock.quantity, batchQuantity, unbatchedQuantity, variance };
      rows.push(row);
      if (unbatchedQuantity === null || Math.abs(variance) > 0.000001) issues.push(row);
    }
    res.json({ healthy: issues.length === 0, issues, rows });
  } catch (error) { res.status(500).json({ message: "Failed to build inventory integrity report" }); }
};

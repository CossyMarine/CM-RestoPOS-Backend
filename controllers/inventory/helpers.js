// controllers/inventory/helpers.js
// Shared internals used across the inventory domain files. Nothing here is
// wired directly to routes — these are the building blocks that
// units/locations/items/stock/transfers/recipes/production/receiving/
// suppliers/purchaseOrders/waste/usage/batches all import from.
import InventoryLocation from "../../models/InventoryLocation.js";
import InventoryStock from "../../models/InventoryStock.js";
import InventoryBatch from "../../models/InventoryBatch.js";
import mongoose from "mongoose";

export const isValidObjectId = (value) => {
  if (value === undefined || value === null || value === "") {
    return false;
  }
  return mongoose.Types.ObjectId.isValid(String(value));
};

export const requireObjectId = (value, label) => {
  if (!isValidObjectId(value)) throw new Error(`Invalid ${label} id`);
  return value;
};

export const requireInventoryIds = (payload, fields) => {
  for (const [field, label] of fields) {
    if (payload[field] !== undefined && payload[field] !== null && payload[field] !== "") requireObjectId(payload[field], label);
  }
};

export const resolveInventoryLocation = async (locationId, fallbackName, businessId) => {
  if (locationId) {
    if (!isValidObjectId(locationId)) throw new Error("Invalid inventory location id");
    const location = await InventoryLocation.findOne({ _id: locationId, businessId });
    if (!location) {
      throw new Error("Inventory location not found");
    }
    return location;
  }

  const fallbackLocation = await InventoryLocation.findOne({
    businessId,
    name: { $regex: `^${fallbackName}$`, $options: "i" },
  });

  if (!fallbackLocation) {
    throw new Error(`Default location '${fallbackName}' not found`);
  }

  return fallbackLocation;
};

export const ensureLocationStockBalance = async (businessId, itemId, locationId, session = null) => {
  let balance = await InventoryStock.findOne({ item: itemId, location: locationId, businessId }).session(session);
  if (!balance) {
    const created = await InventoryStock.create([{ businessId, item: itemId, location: locationId, quantity: 0, unbatchedQuantity: 0 }], { session });
    balance = created[0];
  }
  return balance;
};

export const initializeUnbatchedQuantity = async (stock, session = null) => {
  if (stock.unbatchedQuantity !== undefined && stock.unbatchedQuantity !== null) return stock;
  const [batchTotal] = await InventoryBatch.aggregate([
    { $match: { businessId: stock.businessId, inventoryItem: stock.item, location: stock.location, status: { $ne: "cancelled" } } },
    { $group: { _id: null, quantity: { $sum: "$quantity" } } },
  ]).session(session);
  const unbatchedQuantity = Number(stock.quantity) - Number(batchTotal?.quantity || 0);
  if (unbatchedQuantity < -0.000001) throw new Error("Inventory batch reconciliation required");
  stock.unbatchedQuantity = Math.max(0, unbatchedQuantity);
  await stock.save({ session });
  return stock;
};

export const getBatchStatus = (batchDoc, now = new Date()) => {
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

export const syncBatchStatus = async (batchDoc, session = null) => {
  const nextStatus = getBatchStatus(batchDoc);
  if (batchDoc.status !== nextStatus) {
    batchDoc.status = nextStatus;
    await batchDoc.save({ session });
  }
  return batchDoc;
};

export const buildBatchNumber = async (businessId, inventoryItemId, locationId, suppliedBatchNumber, session = null) => {
  const normalized = typeof suppliedBatchNumber === "string" ? suppliedBatchNumber.trim() : "";
  if (normalized) {
    const duplicate = await InventoryBatch.findOne({
      businessId,
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
  const duplicate = await InventoryBatch.findOne({ businessId, inventoryItem: inventoryItemId, location: locationId, batchNumber: generated }).session(session);
  if (duplicate) {
    return buildBatchNumber(businessId, inventoryItemId, locationId, "", session);
  }
  return generated;
};

export const consumeBatchesForQuantity = async ({ businessId, inventoryItemId, locationId, requiredQuantity, stockBalance, session = null, includeExpired = false }) => {
  const now = new Date();
  await initializeUnbatchedQuantity(stockBalance, session);
  const query = {
    businessId,
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
        { $match: { businessId, inventoryItem: inventoryItemId, location: locationId, quantity: { $gt: 0 }, status: { $ne: "cancelled" }, expiryDate: { $lt: now } } },
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

export const restoreBatchQuantity = async (businessId, batchId, quantity, session = null) => {
  const batch = await InventoryBatch.findOne({ _id: batchId, businessId }).session(session);
  if (!batch) {
    throw new Error("Batch not found");
  }
  batch.quantity = Number(batch.quantity) + Number(quantity);
  batch.status = getBatchStatus(batch);
  await batch.save({ session });
  return batch;
};

export const restoreConsumptionPlan = async ({ businessId, stockBalance, batchUsage = [], legacyQuantityConsumed = 0, session = null }) => {
  for (const usage of batchUsage) await restoreBatchQuantity(businessId, usage.batch, usage.quantityConsumed, session);
  await initializeUnbatchedQuantity(stockBalance, session);
  stockBalance.unbatchedQuantity += Number(legacyQuantityConsumed || 0);
};

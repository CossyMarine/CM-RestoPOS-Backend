// controllers/inventory/waste.js
import InventoryItem from "../../models/InventoryItem.js";
import InventoryUnit from "../../models/InventoryUnit.js";
import InventoryLocation from "../../models/InventoryLocation.js";
import InventoryStock from "../../models/InventoryStock.js";
import InventoryBatch from "../../models/InventoryBatch.js";
import InventoryWaste from "../../models/InventoryWaste.js";
import InventoryUsageLog from "../../models/InventoryUsageLog.js";
import mongoose from "mongoose";
import {
  requireInventoryIds,
  requireObjectId,
  resolveInventoryLocation,
  consumeBatchesForQuantity,
  getBatchStatus,
  initializeUnbatchedQuantity,
  restoreConsumptionPlan,
} from "./helpers.js";

const validateWastePayload = async (payload, businessId) => {
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

  const inventoryItem = await InventoryItem.findOne({ _id: item, businessId });
  if (!inventoryItem) {
    throw new Error("Inventory item not found");
  }
  if (!inventoryItem.isActive) {
    throw new Error("Inventory item is not active");
  }

  const locationDoc = await InventoryLocation.findOne({ _id: location, businessId });
  if (!locationDoc) {
    throw new Error("Inventory location not found");
  }
  if (!locationDoc.isActive) {
    throw new Error("Inventory location is not active");
  }

  const unitDoc = await InventoryUnit.findOne({ _id: unit, businessId });
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
    const { businessId } = req;
    const { item, quantity, unit, reason, note, batch: requestedBatch } = req.body;
    requireInventoryIds(req.body, [["item", "inventory item"], ["location", "location"], ["unit", "unit"], ["batch", "batch"]]);
    const resolvedLocation = await resolveInventoryLocation(req.body.location, "Store", businessId);
    const location = resolvedLocation._id;
    const payload = { item, location, quantity, unit, reason };
    const { inventoryItem, locationDoc } = await validateWastePayload(payload, businessId);

    const normalizedQuantity = Number(quantity);
    const costPerUnit = Number(inventoryItem.costPerUnit || 0);
    const totalValue = normalizedQuantity * costPerUnit;

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      let stockBalance = await InventoryStock.findOne({ item, location, businessId }).session(session);
      if (!stockBalance) {
        stockBalance = await InventoryStock.create([{ businessId, item, location, quantity: 0 }], { session });
        stockBalance = stockBalance[0];
      }

      if (stockBalance.quantity < normalizedQuantity || inventoryItem.currentStock < normalizedQuantity) {
        throw new Error("Insufficient stock");
      }

      let allocation;
      if (requestedBatch) {
        const batch = await InventoryBatch.findOne({ _id: requestedBatch, businessId }).session(session);
        if (!batch || String(batch.inventoryItem) !== String(item) || String(batch.location) !== String(location) || batch.status === "cancelled" || Number(batch.quantity) < normalizedQuantity) { throw new Error("Selected batch does not have enough usable stock"); }
        batch.quantity -= normalizedQuantity;
        batch.status = getBatchStatus(batch);
        await batch.save({ session });
        allocation = { batchUsage: [{ batch: batch._id, quantityConsumed: normalizedQuantity }], legacyQuantityConsumed: 0 };
      } else {
        allocation = await consumeBatchesForQuantity({ businessId, inventoryItemId: item, locationId: location, requiredQuantity: normalizedQuantity, stockBalance, session, includeExpired: true });
      }

      stockBalance.quantity -= normalizedQuantity;
      await stockBalance.save({ session });

      inventoryItem.currentStock -= normalizedQuantity;
      await inventoryItem.save({ session });

      const waste = await InventoryWaste.create(
        [{
          businessId,
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
          businessId,
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

      const populatedWaste = await InventoryWaste.findOne({ _id: waste[0]._id, businessId })
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
    const { businessId } = req;
    const wastes = await InventoryWaste.find({ businessId })
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
    const { businessId } = req;
    const { id } = req.params;
    requireObjectId(id, "waste");
    const waste = await InventoryWaste.findOne({ _id: id, businessId })
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
    const { businessId } = req;
    const { id } = req.params;
    const waste = await InventoryWaste.findOne({ _id: id, businessId });

    if (!waste) {
      return res.status(404).json({ message: "Waste record not found" });
    }

    if (waste.status === "cancelled") {
      return res.status(400).json({ message: "Waste record is already cancelled" });
    }

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const inventoryItem = await InventoryItem.findOne({ _id: waste.item, businessId }).session(session);
      if (!inventoryItem) {
        throw new Error("Inventory item not found");
      }

      const stockBalance = await InventoryStock.findOne({ item: waste.item, location: waste.location, businessId }).session(session);
      if (!stockBalance) {
        throw new Error("Inventory stock balance not found");
      }

      await initializeUnbatchedQuantity(stockBalance, session);
      stockBalance.quantity += waste.quantity;
      await restoreConsumptionPlan({ businessId, stockBalance, batchUsage: waste.batchUsage, legacyQuantityConsumed: waste.legacyQuantityConsumed, session });
      await stockBalance.save({ session });

      inventoryItem.currentStock += waste.quantity;
      await inventoryItem.save({ session });

      waste.status = "cancelled";
      await waste.save({ session });

      await InventoryUsageLog.create(
        [{
          businessId,
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

      const populatedWaste = await InventoryWaste.findOne({ _id: waste._id, businessId })
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

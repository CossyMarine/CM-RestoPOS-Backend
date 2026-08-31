// controllers/inventory/transfers.js
import InventoryItem from "../../models/InventoryItem.js";
import InventoryLocation from "../../models/InventoryLocation.js";
import InventoryTransfer from "../../models/InventoryTransfer.js";
import InventoryBatch from "../../models/InventoryBatch.js";
import mongoose from "mongoose";
import {
  requireInventoryIds,
  ensureLocationStockBalance,
  consumeBatchesForQuantity,
  initializeUnbatchedQuantity,
  getBatchStatus,
} from "./helpers.js";

export const createTransfer = async (req, res) => {
  try {
    const { businessId } = req;
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

    const item = await InventoryItem.findOne({ _id: itemId, businessId });
    if (!item) return res.status(404).json({ message: "Inventory item not found" });

    const sourceLocation = await InventoryLocation.findOne({ _id: fromLocation, businessId });
    const destinationLocation = await InventoryLocation.findOne({ _id: toLocation, businessId });
    if (!sourceLocation || !destinationLocation) {
      return res.status(404).json({ message: "Inventory location not found" });
    }

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const sourceBalance = await ensureLocationStockBalance(businessId, itemId, sourceLocation._id, session);
      const destinationBalance = await ensureLocationStockBalance(businessId, itemId, destinationLocation._id, session);
      if (Number(sourceBalance.quantity) < Number(quantity)) throw new Error("Source location does not have enough stock");
      const allocation = await consumeBatchesForQuantity({ businessId, inventoryItemId: itemId, locationId: sourceLocation._id, requiredQuantity: Number(quantity), stockBalance: sourceBalance, session });
      sourceBalance.quantity -= quantity;
      destinationBalance.quantity += quantity;
      await sourceBalance.save({ session });
      await destinationBalance.save({ session });

      const batchTransfers = [];
      for (const usage of allocation.batchUsage) {
        const sourceBatch = await InventoryBatch.findOne({ _id: usage.batch, businessId }).session(session);
        let destinationBatch = await InventoryBatch.findOne({ businessId, inventoryItem: itemId, location: destinationLocation._id, batchNumber: sourceBatch.batchNumber }).session(session);
        if (!destinationBatch) {
          destinationBatch = (await InventoryBatch.create([{
            businessId,
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
          businessId,
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

      const populatedTransfer = await InventoryTransfer.findOne({ _id: transfer[0]._id, businessId })
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

export const getTransfers = async (req, res) => {
  try {
    const { businessId } = req;
    const { item, fromLocation, toLocation } = req.query;
    const filter = { businessId };
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

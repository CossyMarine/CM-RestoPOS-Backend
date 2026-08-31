// controllers/inventory/receiving.js
import InventoryLocation from "../../models/InventoryLocation.js";
import InventoryItem from "../../models/InventoryItem.js";
import InventoryUnit from "../../models/InventoryUnit.js";
import InventoryStock from "../../models/InventoryStock.js";
import InventoryBatch from "../../models/InventoryBatch.js";
import InventoryReceiving from "../../models/InventoryReceiving.js";
import StockEntry from "../../models/StockEntry.js";
import Supplier from "../../models/Supplier.js";
import PurchaseOrder from "../../models/PurchaseOrder.js";
import mongoose from "mongoose";
import {
  requireObjectId,
  requireInventoryIds,
  buildBatchNumber,
  getBatchStatus,
  initializeUnbatchedQuantity,
} from "./helpers.js";

const validateReceivingPayload = async (payload, businessId) => {
  const { location, items } = payload;

  if (!location) {
    throw new Error("location is required");
  }

  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("At least one item is required");
  }

  const locationDoc = await InventoryLocation.findOne({ _id: location, businessId });
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

    const inventoryItem = await InventoryItem.findOne({ _id: item.inventoryItem, businessId });
    if (!inventoryItem) {
      throw new Error("Inventory item not found");
    }
    if (!inventoryItem.isActive) {
      throw new Error("Inventory item is not active");
    }

    const unitDoc = await InventoryUnit.findOne({ _id: item.unit, businessId });
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
    const { businessId } = req;
    const { supplierName, supplier, purchaseOrder, referenceNumber, location, items, note } = req.body;

    requireObjectId(location, "location");
    if (supplier) requireObjectId(supplier, "supplier");
    if (purchaseOrder) requireObjectId(purchaseOrder, "purchase order");
    for (const item of items || []) requireInventoryIds(item, [["inventoryItem", "inventory item"], ["unit", "unit"]]);

    const payload = { location, items };
    await validateReceivingPayload(payload, businessId);

    const locationDoc = await InventoryLocation.findOne({ _id: location, businessId });
    if (!locationDoc) {
      return res.status(404).json({ message: "Location not found" });
    }

    let supplierDoc = null;
    if (supplier) {
      supplierDoc = await Supplier.findOne({ _id: supplier, businessId });
      if (!supplierDoc) {
        return res.status(404).json({ message: "Supplier not found" });
      }
      if (!supplierDoc.isActive) {
        return res.status(400).json({ message: "Supplier is not active" });
      }
    }

    let purchaseOrderDoc = null;
    if (purchaseOrder) {
      purchaseOrderDoc = await PurchaseOrder.findOne({ _id: purchaseOrder, businessId });
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
      const normalizedQuantity = Number(item.quantity);
      const normalizedCostPerUnit = Number(item.costPerUnit);

      let manufacturingDate;
      let expiryDate;
      if (item.manufacturingDate) {
        manufacturingDate = new Date(item.manufacturingDate);
        if (Number.isNaN(manufacturingDate.getTime())) throw new Error("Invalid manufacturing date");
      }
      if (item.expiryDate) {
        expiryDate = new Date(item.expiryDate);
        if (Number.isNaN(expiryDate.getTime())) throw new Error("Invalid expiry date");
      }
      if (manufacturingDate && expiryDate && expiryDate < manufacturingDate) {
        throw new Error("Expiry date cannot be earlier than manufacturing date");
      }

      if (purchaseOrderDoc) {
        const poItem = purchaseOrderDoc.items.find((entry) => String(entry.inventoryItem) === String(item.inventoryItem));
        if (!poItem) throw new Error("Receiving item not present on purchase order");
        const remaining = Number(poItem.quantityOrdered) - Number(poItem.quantityReceived);
        if (normalizedQuantity > remaining) throw new Error("Receiving quantity exceeds remaining purchase order quantity");
      }

      normalizedItems.push({
        inventoryItem: item.inventoryItem,
        quantity: normalizedQuantity,
        unit: item.unit,
        costPerUnit: normalizedCostPerUnit,
        totalCost: normalizedQuantity * normalizedCostPerUnit,
        batchNumber: item.batchNumber || "",
        manufacturingDate,
        expiryDate,
        batchNote: item.batchNote || "",
      });
    }

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const receiving = await InventoryReceiving.create([
        {
          businessId,
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
        const inventoryItem = await InventoryItem.findOne({ _id: item.inventoryItem, businessId }).session(session);
        if (!inventoryItem) {
          throw new Error("Inventory item not found");
        }

        let stockBalance = await InventoryStock.findOne({ item: item.inventoryItem, location: locationDoc._id, businessId }).session(session);
        if (!stockBalance) {
          stockBalance = await InventoryStock.create([{ businessId, item: item.inventoryItem, location: locationDoc._id, quantity: 0 }], { session });
          stockBalance = stockBalance[0];
        }

        stockBalance.quantity += item.quantity;
        await stockBalance.save({ session });

        inventoryItem.currentStock += item.quantity;
        inventoryItem.costPerUnit = item.costPerUnit;
        await inventoryItem.save({ session });

        const hasBatchInfo = Boolean(item.batchNumber || item.batchNote || item.manufacturingDate || item.expiryDate);
        if (hasBatchInfo) {
          const batchNumber = await buildBatchNumber(businessId, item.inventoryItem, locationDoc._id, item.batchNumber, session);
          const batch = await InventoryBatch.create([
            {
              businessId,
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
          const batchNumber = await buildBatchNumber(businessId, item.inventoryItem, locationDoc._id, "", session);
          const batch = await InventoryBatch.create([{
            businessId,
            batchNumber, inventoryItem: item.inventoryItem, location: locationDoc._id,
            quantity: item.quantity, unit: item.unit, costPerUnit: item.costPerUnit,
            supplier: supplierDoc?._id, receiving: receiving[0]._id, status: "active", note: "",
          }], { session });
          receiving[0].items[index].batch = batch[0]._id;
        }

        await StockEntry.create([
          {
            businessId,
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

      const populatedReceiving = await InventoryReceiving.findOne({ _id: receiving[0]._id, businessId })
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
    const { businessId } = req;
    const receipts = await InventoryReceiving.find({ businessId })
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
    const { businessId } = req;
    const { id } = req.params;
    const receiving = await InventoryReceiving.findOne({ _id: id, businessId })
      .populate({ path: "location", select: "name code" })
      .populate({ path: "items.inventoryItem", populate: { path: "unit", select: "name abbreviation" } })
      .populate({ path: "items.unit", select: "name abbreviation" })
      .populate("receivedBy", "fullName")
      .populate("supplier", "name phone email contactPerson isActive")
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
    const { businessId } = req;
    const { id } = req.params;
    requireObjectId(id, "receiving");
    const receiving = await InventoryReceiving.findOne({ _id: id, businessId });

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
        const inventoryItem = await InventoryItem.findOne({ _id: item.inventoryItem, businessId }).session(session);
        if (!inventoryItem) {
          throw new Error("Inventory item not found");
        }

        const stockBalance = await InventoryStock.findOne({ item: item.inventoryItem, location: receiving.location, businessId }).session(session);
        if (!stockBalance) {
          throw new Error("Inventory stock balance not found");
        }

        if (stockBalance.quantity < item.quantity) {
          throw new Error("Cannot cancel receiving because stock would become negative");
        }

        await initializeUnbatchedQuantity(stockBalance, session);
        if (item.batch) {
          const batch = await InventoryBatch.findOne({ _id: item.batch, businessId }).session(session);
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
        const purchaseOrder = await PurchaseOrder.findOne({ _id: receiving.purchaseOrder, businessId }).session(session);
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

      const populatedReceiving = await InventoryReceiving.findOne({ _id: receiving._id, businessId })
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

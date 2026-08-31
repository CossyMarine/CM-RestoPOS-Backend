// controllers/inventory/purchaseOrders.js
import InventoryItem from "../../models/InventoryItem.js";
import InventoryUnit from "../../models/InventoryUnit.js";
import InventoryLocation from "../../models/InventoryLocation.js";
import Supplier from "../../models/Supplier.js";
import PurchaseOrder from "../../models/PurchaseOrder.js";

const getNextPurchaseOrderNumber = async (businessId) => {
  const lastOrder = await PurchaseOrder.findOne({ businessId, poNumber: { $regex: /^PO-\d+$/ } }).sort({ poNumber: -1 });
  if (!lastOrder) return "PO-000001";
  const match = lastOrder.poNumber.match(/^(PO-)(\d+)$/);
  if (!match) return "PO-000001";
  const nextNumber = Number(match[2]) + 1;
  return `${match[1]}${String(nextNumber).padStart(6, "0")}`;
};

const validatePurchaseOrderPayload = async (payload, businessId) => {
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

  const supplierDoc = await Supplier.findOne({ _id: supplier, businessId });
  if (!supplierDoc) {
    throw new Error("Supplier not found");
  }
  if (!supplierDoc.isActive) {
    throw new Error("Supplier is not active");
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
    if (!item.quantityOrdered || Number(item.quantityOrdered) <= 0) {
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
      throw new Error("Duplicate inventory item in purchase order");
    }
    seenItems.add(key);
  }

  return { supplierDoc, locationDoc };
};

export const createPurchaseOrder = async (req, res) => {
  try {
    const { businessId } = req;
    const { supplier, location, items, note } = req.body;
    const payload = { supplier, location, items };
    await validatePurchaseOrderPayload(payload, businessId);

    const poNumber = await getNextPurchaseOrderNumber(businessId);
    const normalizedItems = items.map((item) => ({
      inventoryItem: item.inventoryItem,
      quantityOrdered: Number(item.quantityOrdered),
      quantityReceived: 0,
      unit: item.unit,
      costPerUnit: Number(item.costPerUnit),
      totalCost: Number(item.quantityOrdered) * Number(item.costPerUnit),
    }));

    const purchaseOrder = await PurchaseOrder.create({
      businessId,
      poNumber,
      supplier,
      location,
      orderedBy: req.user._id,
      items: normalizedItems,
      note: note || "",
      status: "draft",
    });

    const populatedPurchaseOrder = await PurchaseOrder.findOne({ _id: purchaseOrder._id, businessId })
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
    const { businessId } = req;
    const purchaseOrders = await PurchaseOrder.find({ businessId })
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
    const { businessId } = req;
    const { id } = req.params;
    const purchaseOrder = await PurchaseOrder.findOne({ _id: id, businessId })
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
    const { businessId } = req;
    const { id } = req.params;
    const purchaseOrder = await PurchaseOrder.findOne({ _id: id, businessId });
    if (!purchaseOrder) return res.status(404).json({ message: "Purchase order not found" });

    if (["received", "cancelled"].includes(purchaseOrder.status)) {
      return res.status(400).json({ message: "Purchase order cannot be edited" });
    }

    if (purchaseOrder.status === "ordered") {
      return res.status(400).json({ message: "Ordered purchase orders cannot be edited" });
    }

    const { supplier, location, items, note } = req.body;
    const payload = { supplier: supplier ?? purchaseOrder.supplier, location: location ?? purchaseOrder.location, items: items ?? purchaseOrder.items };
    await validatePurchaseOrderPayload(payload, businessId);

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

    const populatedPurchaseOrder = await PurchaseOrder.findOne({ _id: purchaseOrder._id, businessId })
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
    const { businessId } = req;
    const { id } = req.params;
    const purchaseOrder = await PurchaseOrder.findOne({ _id: id, businessId });
    if (!purchaseOrder) return res.status(404).json({ message: "Purchase order not found" });
    if (purchaseOrder.status === "cancelled") return res.status(400).json({ message: "Purchase order is cancelled" });
    if (purchaseOrder.status === "received") return res.status(400).json({ message: "Purchase order is already received" });
    if (!purchaseOrder.items || purchaseOrder.items.length === 0) return res.status(400).json({ message: "Purchase order has no items" });

    purchaseOrder.status = "ordered";
    await purchaseOrder.save();

    const populatedPurchaseOrder = await PurchaseOrder.findOne({ _id: purchaseOrder._id, businessId })
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
    const { businessId } = req;
    const { id } = req.params;
    const purchaseOrder = await PurchaseOrder.findOne({ _id: id, businessId });
    if (!purchaseOrder) return res.status(404).json({ message: "Purchase order not found" });
    if (purchaseOrder.status === "received") return res.status(400).json({ message: "Purchase order is already received" });
    if (purchaseOrder.status === "cancelled") return res.status(400).json({ message: "Purchase order is already cancelled" });

    purchaseOrder.status = "cancelled";
    await purchaseOrder.save();

    const populatedPurchaseOrder = await PurchaseOrder.findOne({ _id: purchaseOrder._id, businessId })
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

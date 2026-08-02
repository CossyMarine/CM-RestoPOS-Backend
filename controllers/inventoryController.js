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
import mongoose from "mongoose";
const resolveInventoryLocation = async (locationId, fallbackName) => {
  if (locationId) {
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

const ensureLocationStockBalance = async (itemId, locationId) => {
  let balance = await InventoryStock.findOne({ item: itemId, location: locationId });
  if (!balance) {
    balance = await InventoryStock.create({ item: itemId, location: locationId, quantity: 0 });
  }
  return balance;
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

    const kitchenBalance = await ensureLocationStockBalance(inventoryItem._id, kitchenLocation._id);
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
    balance.quantity -= plan.quantity;
    await balance.save({ session });

    inventoryItem.currentStock -= plan.quantity;
    await inventoryItem.save({ session });

    const totalValue = plan.quantity * inventoryItem.costPerUnit;
    const usageLog = await InventoryUsageLog.create(
      [{
        item: inventoryItem._id,
        quantity: plan.quantity,
        reason: "used",
        costPerUnit: inventoryItem.costPerUnit,
        totalValue,
        recordedBy: reqUserId,
        note: `Recipe consumption for order ${order._id}`,
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
    const { supplierName, supplier, referenceNumber, location, items, note } = req.body;

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

    const normalizedItems = items.map((item) => ({
      inventoryItem: item.inventoryItem,
      quantity: Number(item.quantity),
      unit: item.unit,
      costPerUnit: Number(item.costPerUnit),
      totalCost: Number(item.quantity) * Number(item.costPerUnit),
    }));

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const receiving = await InventoryReceiving.create([
        {
          supplierName: supplierName || "",
          referenceNumber: referenceNumber || "",
          location: locationDoc._id,
          supplier: supplierDoc?._id || undefined,
          items: normalizedItems,
          receivedBy: req.user._id,
          note: note || "",
          status: "received",
        },
      ], { session });

      for (const item of normalizedItems) {
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

        await StockEntry.create([
          {
            item: item.inventoryItem,
            quantity: item.quantity,
            costPerUnit: item.costPerUnit,
            totalCost: item.totalCost,
            addedBy: req.user._id,
            note: `Receiving ${receiving[0]._id}`,
          },
        ], { session });
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
      .populate("supplier", "name phone email contactPerson isActive");

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

        stockBalance.quantity -= item.quantity;
        await stockBalance.save({ session });

        inventoryItem.currentStock -= item.quantity;
        await inventoryItem.save({ session });
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
    const { producedItem, menuItem, recipe, quantityProduced, unit, ingredientsUsed, location, note, status } = req.body;

    const payload = { producedItem, quantityProduced, unit, ingredientsUsed };
    const { producedItemDoc } = await validateProductionPayload(payload);

    const productionStatus = status || "completed";
    if (productionStatus === "cancelled") {
      return res.status(400).json({ message: "Production cannot be created with cancelled status" });
    }

    const productionLocation = await resolveInventoryLocation(location, "Kitchen");
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

          if (balanceDoc.quantity < Number(ingredient.quantityUsed)) {
            throw new Error(`Insufficient stock for ${inventoryItem.name}`);
          }

          const costPerUnit = inventoryItem.costPerUnit || 0;
          ingredientUsageEntries.push({
            inventoryItem: ingredient.inventoryItem,
            quantityUsed: Number(ingredient.quantityUsed),
            unit: ingredient.unit,
            costPerUnit,
            totalCost: Number(ingredient.quantityUsed) * costPerUnit,
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
          },
        ], { session });
        production = production[0];

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

          balanceDoc.quantity += ingredient.quantityUsed;
          await balanceDoc.save({ session });

          inventoryItem.currentStock += ingredient.quantityUsed;
          await inventoryItem.save({ session });
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

    const sourceBalance = await ensureLocationStockBalance(itemId, sourceLocation._id);
    const destinationBalance = await ensureLocationStockBalance(itemId, destinationLocation._id);

    if (sourceBalance.quantity < quantity) {
      return res.status(400).json({ message: "Source location does not have enough stock" });
    }

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      sourceBalance.quantity -= quantity;
      destinationBalance.quantity += quantity;
      await sourceBalance.save({ session });
      await destinationBalance.save({ session });

      const transfer = await InventoryTransfer.create(
        [{
          item: itemId,
          quantity,
          fromLocation: sourceLocation._id,
          toLocation: destinationLocation._id,
          transferredBy: req.user._id,
          note: note || "",
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
    const { item: itemId, quantity, costPerUnit, note, locationId } = req.body;
    if (!itemId || !quantity || costPerUnit === undefined) {
      return res.status(400).json({ message: "item, quantity and costPerUnit are required" });
    }
    if (quantity <= 0) {
      return res.status(400).json({ message: "quantity must be greater than 0" });
    }

    const item = await InventoryItem.findById(itemId);
    if (!item) return res.status(404).json({ message: "Inventory item not found" });

    const location = await resolveInventoryLocation(locationId, "Store");
    const stockBalance = await ensureLocationStockBalance(itemId, location._id);

    const totalCost = quantity * costPerUnit;

    const entry = await StockEntry.create({
      item: itemId,
      quantity,
      costPerUnit,
      totalCost,
      addedBy: req.user._id,
      note: note || "",
    });

    stockBalance.quantity += quantity;
    await stockBalance.save();

    item.currentStock += quantity;
    item.costPerUnit = costPerUnit; // latest purchase price becomes the running valuation cost
    await item.save();

    res.status(201).json({ entry, item });
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

    const location = await resolveInventoryLocation(locationId, "Kitchen");
    const stockBalance = await ensureLocationStockBalance(itemId, location._id);

    if (stockBalance.quantity - quantity < 0) {
      return res.status(400).json({ message: "Location stock balance cannot be negative" });
    }

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

    stockBalance.quantity -= quantity;
    await stockBalance.save();

    item.currentStock -= quantity;
    await item.save();

    res.status(201).json({ log, item });
  } catch (error) {
    if (error.message === "Inventory location not found" || error.message.includes("Default location")) {
      return res.status(404).json({ message: error.message });
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
    if (!itemId || delta === undefined || delta === 0) {
      return res.status(400).json({ message: "item and a non-zero delta are required" });
    }

    const item = await InventoryItem.findById(itemId);
    if (!item) return res.status(404).json({ message: "Inventory item not found" });

    const location = await resolveInventoryLocation(locationId, "Store");
    const stockBalance = await ensureLocationStockBalance(itemId, location._id);

    if (stockBalance.quantity + delta < 0) {
      return res.status(400).json({ message: "Location stock balance cannot be negative" });
    }

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

    stockBalance.quantity += delta;
    await stockBalance.save();

    item.currentStock += delta;
    await item.save();

    res.status(201).json({ log, item });
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

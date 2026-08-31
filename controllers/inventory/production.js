// controllers/inventory/production.js
import InventoryItem from "../../models/InventoryItem.js";
import InventoryUnit from "../../models/InventoryUnit.js";
import InventoryStock from "../../models/InventoryStock.js";
import InventoryBatch from "../../models/InventoryBatch.js";
import InventoryUsageLog from "../../models/InventoryUsageLog.js";
import Production from "../../models/Production.js";
import mongoose from "mongoose";
import {
  requireInventoryIds,
  resolveInventoryLocation,
  consumeBatchesForQuantity,
  buildBatchNumber,
  initializeUnbatchedQuantity,
  restoreConsumptionPlan,
} from "./helpers.js";

const validateProductionPayload = async (payload, businessId) => {
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

  const producedItemDoc = await InventoryItem.findOne({ _id: producedItem, businessId });
  if (!producedItemDoc) {
    throw new Error("Produced item not found");
  }

  const producedUnit = await InventoryUnit.findOne({ _id: unit, businessId });
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

    const inventoryItem = await InventoryItem.findOne({ _id: ingredient.inventoryItem, businessId });
    if (!inventoryItem) {
      throw new Error("Ingredient inventory item not found");
    }

    const ingredientUnit = await InventoryUnit.findOne({ _id: ingredient.unit, businessId });
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
    const { businessId } = req;
    const { producedItem, menuItem, recipe, quantityProduced, unit, ingredientsUsed, location, note, status, batchNumber, manufacturingDate, expiryDate } = req.body;
    requireInventoryIds(req.body, [["producedItem", "produced item"], ["menuItem", "menu item"], ["recipe", "recipe"], ["unit", "unit"], ["location", "location"]]);
    for (const ingredient of ingredientsUsed || []) requireInventoryIds(ingredient, [["inventoryItem", "inventory item"], ["unit", "unit"]]);

    const payload = { producedItem, quantityProduced, unit, ingredientsUsed };
    const { producedItemDoc } = await validateProductionPayload(payload, businessId);

    const productionStatus = status || "completed";
    if (productionStatus === "cancelled") {
      return res.status(400).json({ message: "Production cannot be created with cancelled status" });
    }

    const productionLocation = await resolveInventoryLocation(location, "Store", businessId);
    let production;

    if (productionStatus === "completed") {
      const session = await mongoose.startSession();
      session.startTransaction();

      try {
        const ingredientUsageEntries = [];
        for (const ingredient of ingredientsUsed) {
          const inventoryItem = await InventoryItem.findOne({ _id: ingredient.inventoryItem, businessId }).session(session);
          if (!inventoryItem) {
            throw new Error("Ingredient inventory item not found");
          }

          let balanceDoc = await InventoryStock.findOne({ item: ingredient.inventoryItem, location: productionLocation._id, businessId }).session(session);
          if (!balanceDoc) {
            balanceDoc = await InventoryStock.create([{ businessId, item: ingredient.inventoryItem, location: productionLocation._id, quantity: 0 }], { session });
            balanceDoc = balanceDoc[0];
          }

          const quantityUsed = Number(ingredient.quantityUsed);
          if (balanceDoc.quantity < quantityUsed || inventoryItem.currentStock < quantityUsed) {
            throw new Error(`Insufficient stock for ${inventoryItem.name}`);
          }

          const costPerUnit = inventoryItem.costPerUnit || 0;
          const batchConsumption = await consumeBatchesForQuantity({
            businessId,
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
          const inventoryItem = await InventoryItem.findOne({ _id: ingredient.inventoryItem, businessId }).session(session);
          if (!inventoryItem) {
            throw new Error("Ingredient inventory item not found");
          }

          let balanceDoc = await InventoryStock.findOne({ item: ingredient.inventoryItem, location: productionLocation._id, businessId }).session(session);
          if (!balanceDoc) {
            balanceDoc = await InventoryStock.create([{ businessId, item: ingredient.inventoryItem, location: productionLocation._id, quantity: 0 }], { session });
            balanceDoc = balanceDoc[0];
          }

          balanceDoc.quantity -= ingredient.quantityUsed;
          await balanceDoc.save({ session });

          inventoryItem.currentStock -= ingredient.quantityUsed;
          await inventoryItem.save({ session });

          await InventoryUsageLog.create(
            [{
              businessId,
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

        let producedBalanceDoc = await InventoryStock.findOne({ item: producedItem, location: productionLocation._id, businessId }).session(session);
        if (!producedBalanceDoc) {
          producedBalanceDoc = await InventoryStock.create([{ businessId, item: producedItem, location: productionLocation._id, quantity: 0 }], { session });
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
        const outputBatchNumber = await buildBatchNumber(businessId, producedItem, productionLocation._id, batchNumber, session);
        const producedBatch = await InventoryBatch.create([{
          businessId,
          batchNumber: outputBatchNumber, inventoryItem: producedItem, location: productionLocation._id,
          quantity: Number(quantityProduced), unit, costPerUnit: outputCostPerUnit,
          manufacturingDate: parsedManufacturingDate, expiryDate: parsedExpiryDate, status: "active", note: note || "",
        }], { session });

        production = await Production.create([
          {
            businessId,
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
        businessId,
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

    const populatedProduction = await Production.findOne({ _id: production._id, businessId })
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
    const { businessId } = req;
    const { status } = req.query;
    const filter = { businessId };
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
    const { businessId } = req;
    const { id } = req.params;
    const production = await Production.findOne({ _id: id, businessId })
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
    const { businessId } = req;
    const { id } = req.params;
    const production = await Production.findOne({ _id: id, businessId });

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
          const inventoryItem = await InventoryItem.findOne({ _id: ingredient.inventoryItem, businessId }).session(session);
          if (!inventoryItem) {
            throw new Error("Ingredient inventory item not found");
          }

          const balanceDoc = await InventoryStock.findOne({ item: ingredient.inventoryItem, location: production.location, businessId }).session(session);
          if (!balanceDoc) {
            throw new Error("Ingredient stock balance not found");
          }

          await initializeUnbatchedQuantity(balanceDoc, session);
          balanceDoc.quantity += ingredient.quantityUsed;
          await balanceDoc.save({ session });

          inventoryItem.currentStock += ingredient.quantityUsed;
          await inventoryItem.save({ session });

          if (Array.isArray(ingredient.batchUsage)) {
            await restoreConsumptionPlan({ businessId, stockBalance: balanceDoc, batchUsage: ingredient.batchUsage, legacyQuantityConsumed: ingredient.legacyQuantityConsumed, session });
          }
        }

        const producedItemDoc = await InventoryItem.findOne({ _id: production.producedItem, businessId }).session(session);
        if (!producedItemDoc) {
          throw new Error("Produced item not found");
        }

        const producedBalanceDoc = await InventoryStock.findOne({ item: production.producedItem, location: production.location, businessId }).session(session);
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
          const producedBatch = await InventoryBatch.findOne({ _id: production.producedBatch, businessId }).session(session);
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

    const populatedProduction = await Production.findOne({ _id: production._id, businessId })
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

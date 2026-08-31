// controllers/inventory/recipes.js
import InventoryLocation from "../../models/InventoryLocation.js";
import InventoryItem from "../../models/InventoryItem.js";
import InventoryUnit from "../../models/InventoryUnit.js";
import InventoryUsageLog from "../../models/InventoryUsageLog.js";
import Recipe from "../../models/Recipe.js";
import MenuItem from "../../models/MenuItem.js";
import { ensureLocationStockBalance, consumeBatchesForQuantity } from "./helpers.js";

const validateRecipePayload = async (payload, businessId) => {
  const { menuItem, ingredients } = payload;

  if (!menuItem) {
    throw new Error("menuItem is required");
  }

  if (!Array.isArray(ingredients) || ingredients.length === 0) {
    throw new Error("At least one ingredient is required");
  }

  const menu = await MenuItem.findOne({ _id: menuItem, businessId });
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

    const inventoryItem = await InventoryItem.findOne({ _id: ingredient.inventoryItem, businessId });
    if (!inventoryItem) {
      throw new Error("Inventory item not found");
    }

    if (seenInventoryItems.has(String(ingredient.inventoryItem))) {
      throw new Error("Duplicate inventory item in recipe");
    }
    seenInventoryItems.add(String(ingredient.inventoryItem));

    const unit = await InventoryUnit.findOne({ _id: ingredient.unit, businessId });
    if (!unit) {
      throw new Error("Unit not found");
    }

    if (String(inventoryItem.unit) !== String(ingredient.unit)) {
      throw new Error("Ingredient unit must match the inventory item's configured unit");
    }
  }

  return { menu };
};

// Called from orderController.js with the just-created/updated Order document.
// businessId is read off the order itself (Order already carries it) rather
// than requiring every call site to thread an extra argument through.
export const consumeRecipeIngredientsForOrder = async (order, reqUserId, session = null) => {
  if (!order || !order.items || order.items.length === 0) {
    return { consumed: false, reason: "No items" };
  }

  const businessId = order.businessId;

  const kitchenLocation = await InventoryLocation.findOne({
    businessId,
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

    const recipe = await Recipe.findOne({ businessId, menuItem: menuItemId, isActive: true }).lean();
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
    const inventoryItem = await InventoryItem.findOne({ _id: plan.inventoryItem, businessId });
    if (!inventoryItem) {
      return { consumed: false, reason: "Inventory item not found" };
    }

    const kitchenBalance = await ensureLocationStockBalance(businessId, inventoryItem._id, kitchenLocation._id, session);
    kitchenBalanceMap.set(String(inventoryItem._id), kitchenBalance);

    if (kitchenBalance.quantity < plan.quantity) {
      return { consumed: false, reason: `Insufficient stock for ${inventoryItem.name}` };
    }
  }

  const usageLogs = [];

  for (const plan of consumptionPlan) {
    const inventoryItem = await InventoryItem.findOne({ _id: plan.inventoryItem, businessId });
    if (!inventoryItem) {
      return { consumed: false, reason: "Inventory item not found" };
    }

    const balance = kitchenBalanceMap.get(String(inventoryItem._id));
    const allocation = await consumeBatchesForQuantity({
      businessId,
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
        businessId,
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

export const createRecipe = async (req, res) => {
  try {
    const { businessId } = req;
    const { menuItem, ingredients, note } = req.body;
    const payload = { menuItem, ingredients };
    await validateRecipePayload(payload, businessId);

    const existingRecipe = await Recipe.findOne({ menuItem, isActive: true, businessId });
    if (existingRecipe) {
      return res.status(400).json({ message: "An active recipe already exists for this menu item" });
    }

    const recipe = await Recipe.create({
      businessId,
      menuItem,
      ingredients,
      note: note || "",
      isActive: true,
    });

    const populatedRecipe = await Recipe.findOne({ _id: recipe._id, businessId })
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

export const getRecipes = async (req, res) => {
  try {
    const { businessId } = req;
    const recipes = await Recipe.find({ isActive: true, businessId })
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

export const getRecipeByMenuItem = async (req, res) => {
  try {
    const { businessId } = req;
    const { menuItemId } = req.params;
    const recipe = await Recipe.findOne({ menuItem: menuItemId, isActive: true, businessId })
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

export const updateRecipe = async (req, res) => {
  try {
    const { businessId } = req;
    const { id } = req.params;
    const { menuItem, ingredients, note, isActive } = req.body;

    const recipe = await Recipe.findOne({ _id: id, businessId });
    if (!recipe) return res.status(404).json({ message: "Recipe not found" });

    const payload = {
      menuItem: menuItem ?? recipe.menuItem,
      ingredients: ingredients ?? recipe.ingredients,
    };
    await validateRecipePayload(payload, businessId);

    if (menuItem && String(menuItem) !== String(recipe.menuItem)) {
      const existingRecipe = await Recipe.findOne({ menuItem, isActive: true, businessId });
      if (existingRecipe) {
        return res.status(400).json({ message: "An active recipe already exists for this menu item" });
      }
    }

    recipe.menuItem = menuItem ?? recipe.menuItem;
    recipe.ingredients = ingredients ?? recipe.ingredients;
    if (note !== undefined) recipe.note = note;
    if (isActive !== undefined) recipe.isActive = isActive;
    await recipe.save();

    const populatedRecipe = await Recipe.findOne({ _id: recipe._id, businessId })
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

export const deleteRecipe = async (req, res) => {
  try {
    const { businessId } = req;
    const { id } = req.params;
    const recipe = await Recipe.findOneAndUpdate({ _id: id, businessId }, { isActive: false }, { new: true });
    if (!recipe) return res.status(404).json({ message: "Recipe not found" });
    res.json({ message: "Recipe deactivated", recipe });
  } catch (error) {
    console.error("Error deleting recipe:", error.message);
    res.status(500).json({ message: "Failed to deactivate recipe" });
  }
};

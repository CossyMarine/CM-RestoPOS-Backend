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

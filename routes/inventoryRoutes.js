// routes/inventoryRoutes.js
import express from "express";
import mongoose from "mongoose";
import {
  getUnits, createUnit, deleteUnit, getLocations, createLocation, updateLocation, deleteLocation,
  getItems, createItem, updateItem, deleteItem,
  getLocationStock, getItemLocationStock, getAllLocationStock,
  createTransfer, getTransfers,
  createRecipe, getRecipes, getRecipeByMenuItem, updateRecipe, deleteRecipe,
  createProduction, getProductions, getProductionById, cancelProduction,
  createReceiving, getReceivings, getReceivingById, cancelReceiving,
  createSupplier, getSuppliers, getSupplierById, updateSupplier, deleteSupplier, getSupplierReceivings,
  createPurchaseOrder, getPurchaseOrders, getPurchaseOrderById, updatePurchaseOrder, orderPurchaseOrder, cancelPurchaseOrder,
  createWaste, getWastes, getWasteById, cancelWaste,
  addStock, getStockHistory, logUsage, adjustStock, getUsageHistory,
  getUsageOverview, getItemUsageDetail, getInventorySummary,
  getBatches, getBatchById, getExpiringBatches, getInventoryIntegrity,
} from "../controllers/inventoryController.js";
import { protect, authorize, requirePermission } from "../Middlewares/authMiddleware.js";

const router = express.Router();

// Reject malformed identifiers before controllers issue a Mongoose query. The
// recursive walk also covers receiving/production arrays without changing the
// established request payloads.
const inventoryIdFields = new Set([
  "id", "item", "itemId", "inventoryItem", "location", "locationId",
  "fromLocation", "toLocation", "unit", "supplier", "purchaseOrder",
  "menuItem", "menuItemId", "recipe", "batch",
]);
const validateInventoryObjectIds = (req, res, next) => {
  let invalid = null;
  const visit = (value, key = "") => {
    if (invalid || value === undefined || value === null || value === "") return;
    if (Array.isArray(value)) return value.forEach((entry) => visit(entry));
    if (typeof value === "object") return Object.entries(value).forEach(([childKey, childValue]) => visit(childValue, childKey));
    if (inventoryIdFields.has(key) && !mongoose.Types.ObjectId.isValid(String(value))) invalid = key;
  };
  visit(req.params);
  visit(req.query);
  visit(req.body);
  return invalid ? res.status(400).json({ message: `Invalid ${invalid} id` }) : next();
};
router.use(validateInventoryObjectIds);

// Kitchen keeps its existing free access. Accountant only gets in if granted
// the "inventory" permission; admin always passes.
const kitchenOrAdmin = authorize("admin", "kitchen");
const gated = [authorize("admin", "kitchen", "accountant"), requirePermission("inventory")];
// requirePermission 403s a plain "kitchen" role since it only checks
// isAdmin / accountant permissions — so kitchen still needs its own bypass.
// Simplest fix: give requirePermission a pass-through for any role that
// isn't "accountant" (kitchen keeps working, accountant gets gated).

router.get("/units", protect, authorize("admin", "accountant"), requirePermission("inventory"), getUnits);
router.post("/units", protect, authorize("admin"), requirePermission("inventory"), createUnit);
router.delete("/units/:id", protect, authorize("admin"), requirePermission("inventory"), deleteUnit);

router.get("/locations", protect, authorize("admin", "accountant"), requirePermission("inventory"), getLocations);
router.post("/locations", protect, authorize("admin"), requirePermission("inventory"), createLocation);
router.put("/locations/:id", protect, authorize("admin"), requirePermission("inventory"), updateLocation);
router.delete("/locations/:id", protect, authorize("admin"), requirePermission("inventory"), deleteLocation);

router.get("/items", protect, authorize("admin", "kitchen", "accountant"), requirePermission("inventory"), getItems);
router.post("/items", protect, authorize("admin"), requirePermission("inventory"), createItem);

router.get("/stock/locations/:locationId", protect, authorize("admin", "accountant"), requirePermission("inventory"), getLocationStock);
router.get("/stock/items/:itemId", protect, authorize("admin", "accountant"), requirePermission("inventory"), getItemLocationStock);
router.get("/stock/locations", protect, authorize("admin", "accountant"), requirePermission("inventory"), getAllLocationStock);
router.post("/transfers", protect, authorize("admin"), requirePermission("inventory"), createTransfer);
router.get("/transfers", protect, authorize("admin", "accountant"), requirePermission("inventory"), getTransfers);
router.post("/recipes", protect, authorize("admin"), requirePermission("inventory"), createRecipe);
router.get("/recipes", protect, authorize("admin", "accountant"), requirePermission("inventory"), getRecipes);
router.get("/recipes/:menuItemId", protect, authorize("admin", "accountant"), requirePermission("inventory"), getRecipeByMenuItem);
router.put("/recipes/:id", protect, authorize("admin"), requirePermission("inventory"), updateRecipe);
router.delete("/recipes/:id", protect, authorize("admin"), requirePermission("inventory"), deleteRecipe);
router.post("/production", protect, authorize("admin", "kitchen"), requirePermission("inventory"), createProduction);
router.get("/production", protect, authorize("admin", "kitchen", "accountant"), requirePermission("inventory"), getProductions);
router.get("/production/:id", protect, authorize("admin", "kitchen", "accountant"), requirePermission("inventory"), getProductionById);
router.delete("/production/:id", protect, authorize("admin", "kitchen"), requirePermission("inventory"), cancelProduction);
router.post("/receiving", protect, authorize("admin"), requirePermission("inventory"), createReceiving);
router.get("/receiving", protect, authorize("admin", "accountant"), requirePermission("inventory"), getReceivings);
router.get("/receiving/:id", protect, authorize("admin", "accountant"), requirePermission("inventory"), getReceivingById);
router.delete("/receiving/:id", protect, authorize("admin"), requirePermission("inventory"), cancelReceiving);
router.post("/suppliers", protect, authorize("admin"), requirePermission("inventory"), createSupplier);
router.get("/suppliers", protect, authorize("admin", "accountant", "kitchen"), requirePermission("inventory"), getSuppliers);
router.get("/suppliers/:id", protect, authorize("admin", "accountant", "kitchen"), requirePermission("inventory"), getSupplierById);
router.put("/suppliers/:id", protect, authorize("admin"), requirePermission("inventory"), updateSupplier);
router.delete("/suppliers/:id", protect, authorize("admin"), requirePermission("inventory"), deleteSupplier);
router.get("/suppliers/:id/receivings", protect, authorize("admin", "accountant", "kitchen"), requirePermission("inventory"), getSupplierReceivings);
router.post("/purchase-orders", protect, authorize("admin"), requirePermission("inventory"), createPurchaseOrder);
router.get("/purchase-orders", protect, authorize("admin", "accountant"), requirePermission("inventory"), getPurchaseOrders);
router.get("/purchase-orders/:id", protect, authorize("admin", "accountant"), requirePermission("inventory"), getPurchaseOrderById);
router.put("/purchase-orders/:id", protect, authorize("admin"), requirePermission("inventory"), updatePurchaseOrder);
router.post("/purchase-orders/:id/order", protect, authorize("admin"), requirePermission("inventory"), orderPurchaseOrder);
router.post("/purchase-orders/:id/cancel", protect, authorize("admin"), requirePermission("inventory"), cancelPurchaseOrder);
router.post("/waste", protect, authorize("admin", "kitchen"), requirePermission("inventory"), requireOpenShift, createWaste);
router.get("/waste", protect, authorize("admin", "accountant", "kitchen"), requirePermission("inventory"), getWastes);
router.get("/waste/:id", protect, authorize("admin", "accountant", "kitchen"), requirePermission("inventory"), getWasteById);
router.delete("/waste/:id", protect, authorize("admin", "kitchen"), requirePermission("inventory"), cancelWaste);
router.put("/items/:id", protect, authorize("admin"), requirePermission("inventory"), updateItem);
router.delete("/items/:id", protect, authorize("admin"), requirePermission("inventory"), deleteItem);

router.get("/stock", protect, authorize("admin", "accountant"), requirePermission("inventory"), getStockHistory);
router.post("/stock", protect, authorize("admin"), requirePermission("inventory"), addStock);

router.get("/usage/overview", protect, authorize("admin", "kitchen", "accountant"), requirePermission("inventory"), getUsageOverview);
router.get("/usage/:itemId/detail", protect, authorize("admin", "kitchen", "accountant"), requirePermission("inventory"), getItemUsageDetail);
router.get("/usage", protect, authorize("admin"), requirePermission("inventory"), getUsageHistory);
router.post("/usage", protect, authorize("admin", "kitchen"), requireOpenShift, logUsage);
router.post("/adjust", protect, authorize("admin"), requirePermission("inventory"), adjustStock);

router.get("/summary", protect, authorize("admin", "accountant"), requirePermission("inventory"), getInventorySummary);
router.get("/integrity", protect, authorize("admin"), requirePermission("inventory"), getInventoryIntegrity);
router.get("/batches/expiring", protect, authorize("admin", "accountant"), requirePermission("inventory"), getExpiringBatches);
router.get("/batches", protect, authorize("admin", "accountant"), requirePermission("inventory"), getBatches);
router.get("/batches/:id", protect, authorize("admin", "accountant"), requirePermission("inventory"), getBatchById);

export default router;

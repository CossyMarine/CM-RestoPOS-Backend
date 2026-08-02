// routes/inventoryRoutes.js
import express from "express";
import {
  getUnits, createUnit, deleteUnit, getLocations, createLocation, updateLocation, deleteLocation,
  getItems, createItem, updateItem, deleteItem,
  getLocationStock, getItemLocationStock, getAllLocationStock,
  createTransfer, getTransfers,
  createRecipe, getRecipes, getRecipeByMenuItem, updateRecipe, deleteRecipe,
  createProduction, getProductions, getProductionById, cancelProduction,
  addStock, getStockHistory, logUsage, adjustStock, getUsageHistory,
  getUsageOverview, getItemUsageDetail, getInventorySummary,
} from "../controllers/inventoryController.js";
import { protect, authorize, requirePermission } from "../Middlewares/authMiddleware.js";

const router = express.Router();

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
router.put("/items/:id", protect, authorize("admin"), requirePermission("inventory"), updateItem);
router.delete("/items/:id", protect, authorize("admin"), requirePermission("inventory"), deleteItem);

router.get("/stock", protect, authorize("admin", "accountant"), requirePermission("inventory"), getStockHistory);
router.post("/stock", protect, authorize("admin"), requirePermission("inventory"), addStock);

router.get("/usage/overview", protect, authorize("admin", "kitchen", "accountant"), requirePermission("inventory"), getUsageOverview);
router.get("/usage/:itemId/detail", protect, authorize("admin", "kitchen", "accountant"), requirePermission("inventory"), getItemUsageDetail);
router.get("/usage", protect, authorize("admin"), requirePermission("inventory"), getUsageHistory);
router.post("/usage", protect, authorize("admin", "kitchen"), logUsage);
router.post("/adjust", protect, authorize("admin"), requirePermission("inventory"), adjustStock);

router.get("/summary", protect, authorize("admin", "accountant"), requirePermission("inventory"), getInventorySummary);

export default router;

// routes/inventoryRoutes.js
import express from "express";
import {
  getUnits,
  createUnit,
  deleteUnit,
  getItems,
  createItem,
  updateItem,
  deleteItem,
  addStock,
  getStockHistory,
  logUsage,
  adjustStock,
  getUsageHistory,
  getUsageOverview,
  getItemUsageDetail,
  getInventorySummary,
} from "../controllers/inventoryController.js";
import { protect, authorize, requirePermission } from "../Middlewares/authMiddleware.js";

const router = express.Router();

// Admins pass through free; accountants need the "inventory" permission granted.
const adminOnly = [authorize("admin", "accountant"), requirePermission("inventory")];
const adminAndKitchen = [authorize("admin", "kitchen", "accountant"), requirePermission("inventory")];
// (kitchen role still passes authorize() on its own role match — requirePermission
// only applies its check when req.user.isAdmin is false AND role is accountant;
// for a plain "kitchen" user requirePermission would 403 them, so keep kitchen
// on a separate check)
const kitchenOrAdmin = authorize("admin", "kitchen");

router.get("/units", protect, ...adminOnly, getUnits);
router.post("/units", protect, ...adminOnly, createUnit);
router.delete("/units/:id", protect, ...adminOnly, deleteUnit);

router.get("/items", protect, kitchenOrAdmin, getItems); // kitchen keeps unrestricted read access
router.get("/items", protect, ...adminOnly, getItems); // accountant path (see note below)
router.post("/items", protect, ...adminOnly, createItem);
router.put("/items/:id", protect, ...adminOnly, updateItem);
router.delete("/items/:id", protect, ...adminOnly, deleteItem);

router.get("/stock", protect, ...adminOnly, getStockHistory);
router.post("/stock", protect, ...adminOnly, addStock);

router.get("/usage/overview", protect, kitchenOrAdmin, getUsageOverview);
router.get("/usage/:itemId/detail", protect, kitchenOrAdmin, getItemUsageDetail);
router.get("/usage", protect, ...adminOnly, getUsageHistory);
router.post("/usage", protect, kitchenOrAdmin, logUsage);
router.post("/adjust", protect, ...adminOnly, adjustStock);

router.get("/summary", protect, ...adminOnly, getInventorySummary);

export default router;

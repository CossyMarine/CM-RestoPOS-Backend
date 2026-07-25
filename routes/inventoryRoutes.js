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
import { protect, authorize } from "../Middlewares/authMiddleware.js";

const router = express.Router();

const adminOnly = authorize("admin");
const adminAndKitchen = authorize("admin", "kitchen");

// Units — admin-defined measurement vocabulary
router.get("/units", protect, adminOnly, getUnits);
router.post("/units", protect, adminOnly, createUnit);
router.delete("/units/:id", protect, adminOnly, deleteUnit);

// Items — the ingredient/stock catalog itself
router.get("/items", protect, adminAndKitchen, getItems);
router.post("/items", protect, adminOnly, createItem);
router.put("/items/:id", protect, adminOnly, updateItem);
router.delete("/items/:id", protect, adminOnly, deleteItem);

// Stock — admin restocks + sets purchase price
router.get("/stock", protect, adminOnly, getStockHistory);
router.post("/stock", protect, adminOnly, addStock);

// Usage — kitchen logs consumption/waste; admin can correct via /adjust
router.get("/usage/overview", protect, adminAndKitchen, getUsageOverview);
router.get("/usage/:itemId/detail", protect, adminAndKitchen, getItemUsageDetail);
router.get("/usage", protect, adminOnly, getUsageHistory);
router.post("/usage", protect, adminAndKitchen, logUsage);
router.post("/adjust", protect, adminOnly, adjustStock);

// Summary — for dashboard financial reporting
router.get("/summary", protect, adminOnly, getInventorySummary);

export default router;

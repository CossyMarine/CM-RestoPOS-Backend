import express from "express";
import { protect, authorize, requirePermission } from "../Middlewares/authMiddleware.js";
import {
  getWaiterManagementList, getWaiterDetail, dropWaiter, restoreWaiter, deleteWaiter,
  getSelectorList, toggleWaiterVisibility, getWaiterSelectorSettings, updateWaiterSelectorSettings,
} from "../controllers/waiterManagementController.js";

const router = express.Router();
const gate = [authorize("admin", "accountant"), requirePermission("waiterManagement")];

router.get("/management", protect, ...gate, getWaiterManagementList);
router.get("/management/:id", protect, ...gate, getWaiterDetail);
router.patch("/management/:id/drop", protect, ...gate, dropWaiter);
router.patch("/management/:id/restore", protect, ...gate, restoreWaiter);
router.delete("/management/:id", protect, ...gate, deleteWaiter);
router.get("/selector-list", protect, ...gate, getSelectorList);
router.patch("/:id/visibility", protect, ...gate, toggleWaiterVisibility);
router.get("/management/:id/selector-settings", protect, ...gate, getWaiterSelectorSettings);
router.patch("/management/:id/selector-settings", protect, ...gate, updateWaiterSelectorSettings);

export default router;

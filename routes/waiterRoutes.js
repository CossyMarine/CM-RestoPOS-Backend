import express from "express";
import { protect, authorize } from "../Middlewares/authMiddleware.js";
import {
  getWaiterManagementList,
  getWaiterDetail,
  dropWaiter,
  restoreWaiter,
  deleteWaiter,
  getSelectorList,
  toggleWaiterVisibility,
} from "../controllers/waiterManagementController.js";

const router = express.Router();

router.get("/management", protect, authorize("admin"), getWaiterManagementList);
router.get("/management/:id", protect, authorize("admin"), getWaiterDetail);
router.patch("/management/:id/drop", protect, authorize("admin"), dropWaiter);
router.patch("/management/:id/restore", protect, authorize("admin"), restoreWaiter);
router.delete("/management/:id", protect, authorize("admin"), deleteWaiter);
router.get("/selector-list", protect, authorize("admin"), getSelectorList);
router.patch("/:id/visibility", protect, authorize("admin"), toggleWaiterVisibility);

export default router;

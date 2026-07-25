// routes/kitchenSettingsRoutes.js
import express from "express";
import { protect, authorize, requirePermission } from "../Middlewares/authMiddleware.js";
import { getKitchenSettings, updateKitchenSettings } from "../controllers/kitchenSettingsController.js";

const router = express.Router();

router.get("/", protect, authorize("kitchen", "admin", "accountant"), requirePermission("kitchen"), getKitchenSettings);
router.patch("/", protect, authorize("admin", "accountant"), requirePermission("kitchen"), updateKitchenSettings);

export default router;

// routes/kitchenSettingsRoutes.js
import express from "express";
import { protect, authorize } from "../Middlewares/authMiddleware.js";
import { getKitchenSettings, updateKitchenSettings } from "../controllers/kitchenSettingsController.js";

const router = express.Router();

router.get("/", protect, authorize("kitchen", "admin"), getKitchenSettings);
router.patch("/", protect, authorize("admin"), updateKitchenSettings);

export default router;

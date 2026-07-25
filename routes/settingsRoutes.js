// routes/settingsRoutes.js
import express from "express";
import { protect, authorize, requirePermission } from "../Middlewares/authMiddleware.js";
import { getSettings, updateSettings, getPublicSettings } from "../controllers/settingsController.js";

const router = express.Router();

router.get("/public", getPublicSettings);
router.get("/", protect, authorize("admin", "accountant"), requirePermission("settings"), getSettings);
router.patch("/", protect, authorize("admin", "accountant"), requirePermission("settings"), updateSettings);

export default router;

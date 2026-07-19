// routes/settingsRoutes.js
import express from "express";
import { protect, authorize } from "../Middlewares/authMiddleware.js";
import { getSettings, updateSettings, getPublicSettings } from "../controllers/settingsController.js";

const router = express.Router();

router.get("/public", getPublicSettings);
router.get("/", protect, authorize("admin"), getSettings);
router.patch("/", protect, authorize("admin"), updateSettings);

export default router;

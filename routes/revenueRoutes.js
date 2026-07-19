// routes/revenueRoutes.js
import express from "express";
import { getTodayRevenue, getRevenueSummary } from "../controllers/revenueController.js";
import { protect, authorize } from "../Middlewares/authMiddleware.js";

const router = express.Router();

router.get("/today", getTodayRevenue);
router.get("/summary", protect, authorize("admin"), getRevenueSummary);

export default router;

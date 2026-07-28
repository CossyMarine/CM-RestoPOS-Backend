// routes/revenueRoutes.js
import express from "express";
import {
  getTodayRevenue,
  getRevenueSummary,
  getRevenueTrend,
  getWeeklyPerformance,
  getTopMeals,
} from "../controllers/revenueController.js";
import { protect, authorize } from "../Middlewares/authMiddleware.js";

const router = express.Router();

router.get("/today", getTodayRevenue);
router.get("/summary", protect, authorize("admin"), getRevenueSummary);
router.get("/trend", protect, authorize("admin"), getRevenueTrend);
router.get("/weekly", protect, authorize("admin"), getWeeklyPerformance);
router.get("/top-meals", protect, authorize("admin"), getTopMeals);

export default router;
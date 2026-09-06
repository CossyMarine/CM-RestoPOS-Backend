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

router.get("/today", protect, authorize("admin", "accountant"), getTodayRevenue);
router.get("/summary", protect, authorize("admin", "accountant"), getRevenueSummary);
router.get("/trend", protect, authorize("admin", "accountant"), getRevenueTrend);
router.get("/weekly", protect, authorize("admin", "accountant"), getWeeklyPerformance);
router.get("/top-meals", protect, authorize("admin", "accountant"), getTopMeals);

export default router;
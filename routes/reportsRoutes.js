// routes/reportsRoutes.js
import express from "express";
import { getDailyReport, getMonthlyReport, getTaxReport } from "../controllers/reportsController.js";
import { protect, authorize } from "../Middlewares/authMiddleware.js";

const router = express.Router();

router.get("/daily", protect, authorize("admin"), getDailyReport);
router.get("/monthly", protect, authorize("admin"), getMonthlyReport);
router.get("/tax", protect, authorize("admin"), getTaxReport);

export default router;
import express from "express";
import {
  openShift, getCurrentShift, addPettyCash, getShiftSummary, closeShift,
  getShiftHistory, openShiftForWaiter, getShiftStatusForWaiter, getShiftReport,
} from "../controllers/shiftController.js";
import { protect, authorize } from "../Middlewares/authMiddleware.js";

const router = express.Router();

router.post("/open", protect, openShift);
router.get("/current", protect, getCurrentShift);
router.post("/:id/petty-cash", protect, addPettyCash);
router.get("/:id/summary", protect, getShiftSummary);
router.post("/:id/close", protect, closeShift);

// NEW — station-managed shifts for named waiters
router.post("/waiter/:waiterId/open", protect, authorize("waiter", "admin"), openShiftForWaiter);
router.get("/waiter/:waiterId/status", protect, authorize("waiter", "admin"), getShiftStatusForWaiter);

router.get("/history/:userId", protect, authorize("admin"), getShiftHistory);
router.get("/report", protect, authorize("admin"), getShiftReport);

export default router;
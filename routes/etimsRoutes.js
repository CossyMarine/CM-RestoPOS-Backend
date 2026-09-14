import express from "express";
import { protect, authorize } from "../Middlewares/authMiddleware.js";
// AFTER
import {
  listEtimsSubmissions,
  retryEtimsSubmission,
  getEtimsConfig,
  setEtimsConfig,
  getEtimsReconciliation,
} from "../controllers/etimsController.js";

const router = express.Router();

router.get("/reconciliation", protect, authorize("admin"), getEtimsReconciliation);
router.get("/submissions", protect, authorize("admin"), listEtimsSubmissions);
router.post("/submissions/:id/retry", protect, authorize("admin"), retryEtimsSubmission);

router.get("/config", protect, authorize("admin"), getEtimsConfig);
router.put("/config", protect, authorize("admin"), setEtimsConfig);

export default router;
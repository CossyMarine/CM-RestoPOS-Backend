import express from "express";
import { protect, authorize } from "../Middlewares/authMiddleware.js";
import {
  listEtimsSubmissions,
  retryEtimsSubmission,
  getEtimsConfig,
  setEtimsConfig,
} from "../controllers/etimsController.js";

const router = express.Router();

router.get("/submissions", protect, authorize("admin"), listEtimsSubmissions);
router.post("/submissions/:id/retry", protect, authorize("admin"), retryEtimsSubmission);

router.get("/config", protect, authorize("admin"), getEtimsConfig);
router.put("/config", protect, authorize("admin"), setEtimsConfig);

export default router;
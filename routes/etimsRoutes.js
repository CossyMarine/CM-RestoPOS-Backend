import express from "express";
import { protect, authorize } from "../Middlewares/authMiddleware.js";
import { listEtimsSubmissions, retryEtimsSubmission } from "../controllers/etimsController.js";

const router = express.Router();
router.get("/submissions", protect, authorize("admin"), listEtimsSubmissions);
router.post("/submissions/:id/retry", protect, authorize("admin"), retryEtimsSubmission);

export default router;
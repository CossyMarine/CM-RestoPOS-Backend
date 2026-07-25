// routes/accountantRoutes.js
import express from "express";
import { protect, authorize } from "../Middlewares/authMiddleware.js";
import {
  listAccountants,
  getAccountantStats,
  updateAccountantPermissions,
} from "../controllers/accountantController.js";

const router = express.Router();

router.get("/", protect, authorize("admin"), listAccountants);
router.get("/:id/stats", protect, authorize("admin"), getAccountantStats);
router.patch("/:id/permissions", protect, authorize("admin"), updateAccountantPermissions);

export default router;

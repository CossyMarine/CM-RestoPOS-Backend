// routes/voidRequestRoutes.js
import express from "express";
import {
  getVoidRequests,
  createVoidRequest,
  approveVoidRequest,
  rejectVoidRequest,
} from "../controllers/voidRequestController.js";
import { protect, authorize } from "../Middlewares/authMiddleware.js";

const router = express.Router();

router.get("/", protect, authorize("admin"), getVoidRequests);
router.post(
  "/",
  protect,
  authorize("waiter", "manager", "cashier", "admin"),
  createVoidRequest
);
router.patch("/:id/approve", protect, authorize("admin"), approveVoidRequest);
router.patch("/:id/reject", protect, authorize("admin"), rejectVoidRequest);

export default router;

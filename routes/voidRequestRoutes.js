// routes/voidRequestRoutes.js
import express from "express";
import {
  getVoidRequests,
  createVoidRequest,
  approveVoidRequest,
  rejectVoidRequest,
} from "../controllers/voidRequestController.js";
import { protect, authorize, requirePermission } from "../Middlewares/authMiddleware.js";

const router = express.Router();

router.get("/", protect, authorize("admin", "accountant"), requirePermission("voidRequests"), getVoidRequests);
router.post("/", protect, authorize("waiter", "manager", "cashier", "admin"), createVoidRequest);
router.patch("/:id/approve", protect, authorize("admin", "accountant"), requirePermission("voidRequests"), approveVoidRequest);
router.patch("/:id/reject", protect, authorize("admin", "accountant"), requirePermission("voidRequests"), rejectVoidRequest);

export default router;

// routes/orderRoutes.js
import express from "express";
import {
  createOrder,
  getPendingOrders,
  updateOrderStatus,
  assignOrderWaiter,
} from "../controllers/orderController.js";
import {
  createCustomerOrder,
  getCustomerOrders,
  cancelCustomerOrder,
} from "../controllers/customerOrderController.js";
import { protect, authorize } from "../Middlewares/authMiddleware.js";

const router = express.Router();

router.post("/", protect, authorize("cashier", "manager", "admin", "waiter"), createOrder);

router.get("/pending", protect, getPendingOrders);
router.patch("/:id/status", protect, authorize("kitchen", "manager", "admin"), updateOrderStatus);
router.patch("/:id/assign", protect, authorize("waiter", "manager", "admin"), assignOrderWaiter);

// Customer self-service ordering — now requires a registered, logged-in account
router.post("/customer", protect, createCustomerOrder);
router.get("/customer", protect, getCustomerOrders);
router.patch("/customer/:id/cancel", protect, cancelCustomerOrder);

export default router;

// routes/orderRoutes.js
import express from "express";
import {
  createOrder,
  getPendingOrders,
  updateOrderStatus,
  assignOrderWaiter,
  toggleItemReady,
  getOrderHistory,
  getKitchenStats,
} from "../controllers/orderController.js";
import {
  createCustomerOrder,
  getCustomerOrders,
  cancelCustomerOrder,
} from "../controllers/customerOrderController.js";
import {
  protect,
  authorize,
  requirePermission,
  requireOpenShiftForWaiter,
  requireOpenShift,
} from "../Middlewares/authMiddleware.js";

const router = express.Router();

router.post("/", protect, authorize("admin", "waiter"), requireOpenShiftForWaiter(), createOrder);

router.get("/pending", protect, getPendingOrders);
router.get("/history", protect, authorize("kitchen", "admin"), getOrderHistory);
router.get("/kitchen/stats", protect, authorize("kitchen", "admin", "accountant"), requirePermission("kitchen"), getKitchenStats);

router.patch("/:id/status", protect, authorize("kitchen", "admin"), requireOpenShift, updateOrderStatus);
router.patch(
  "/:id/items/:itemIndex/ready",
  protect,
  authorize("kitchen", "admin"),
  requireOpenShift,
  toggleItemReady
);
router.patch("/:id/assign", protect, authorize("admin", "waiter"), requireOpenShiftForWaiter(), assignOrderWaiter);

// Customer self-service ordering — now requires a registered, logged-in account
router.post("/customer", protect, createCustomerOrder);
router.get("/customer", protect, getCustomerOrders);
router.patch("/customer/:id/cancel", protect, cancelCustomerOrder);

export default router;
// controllers/orderController.js
import Order from "../models/Order.js";
import Receipt from "../models/Receipt.js";
import { generateReceiptForOrder } from "../utils/generateReceipt.js";

// @desc    Create a new order and receipt (staff/manual entry)
// @route   POST /api/orders
// @access  Protected — cashier, manager, admin, waiter
export const createOrder = async (req, res) => {
  const { tableNumber, waiterName, items, subtotal } = req.body;

  if (!items || items.length === 0) {
    return res.status(400).json({ message: "Order must have at least one item" });
  }

  try {
    const order = await Order.create({
      tableNumber,
      waiterName,
      items,
      subtotal,
      source: "staff",
    });

    const receipt = await generateReceiptForOrder(order);

    const io = req.app.get("io");
    io.emit("order:created", { order, receipt, source: "staff" });

    res.status(201).json({ order, receipt, items: order.items });
  } catch (error) {
    console.error("Error creating order:", error.message);
    res.status(500).json({ message: "Failed to create order", error: error.message });
  }
};

// @desc    Get all orders the kitchen hasn't finished
// @route   GET /api/orders/pending
// @access  Protected
export const getPendingOrders = async (req, res) => {
  try {
    const orders = await Order.find({ status: "pending" }).sort({ createdAt: 1 });
    res.json(orders);
  } catch (error) {
    console.error("Error fetching pending orders:", error.message);
    res.status(500).json({ message: "Failed to fetch pending orders", error: error.message });
  }
};

// @desc    Update an order's status
// @route   PATCH /api/orders/:id/status
// @access  Protected — kitchen, manager, admin
export const updateOrderStatus = async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  const allowedStatuses = ["pending", "completed", "cancelled"];
  if (!allowedStatuses.includes(status)) {
    return res.status(400).json({ message: "Invalid status value" });
  }

  try {
    const order = await Order.findByIdAndUpdate(id, { status }, { new: true });

    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    const io = req.app.get("io");
    io.emit("order:updated", order);

    res.json(order);
  } catch (error) {
    console.error("Error updating order status:", error.message);
    res.status(500).json({ message: "Failed to update order status", error: error.message });
  }
};

// @desc    A waiter claims an online order (assigns themselves as server of record)
// @route   PATCH /api/orders/:id/assign
// @access  Protected — waiter, manager, admin
export const assignOrderWaiter = async (req, res) => {
  const { id } = req.params;
  const { waiterName } = req.body;

  if (!waiterName) {
    return res.status(400).json({ message: "waiterName is required" });
  }

  try {
    const order = await Order.findById(id);
    if (!order) return res.status(404).json({ message: "Order not found" });
    if (order.source !== "online") {
      return res.status(400).json({ message: "Only online orders can be claimed this way" });
    }

    order.waiterName = waiterName;
    await order.save();

    await Receipt.findOneAndUpdate({ order: order._id }, { waiterName });

    const io = req.app.get("io");
    io.emit("order:updated", order);

    res.json(order);
  } catch (error) {
    console.error("Error assigning order:", error.message);
    res.status(500).json({ message: "Failed to assign order", error: error.message });
  }
};

// controllers/orderController.js
import Order from "../models/Order.js";
import Receipt from "../models/Receipt.js";
import Shift from "../models/Shift.js";
import User from "../models/User.js";
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
    // Shift gate — only enforced when the order is attributed to a named waiter.
    if (waiterName) {
      const waiterUser = await User.findOne({ fullName: waiterName, role: "waiter" }).select("_id");
      if (waiterUser) {
        const openShift = await Shift.findOne({ openedBy: waiterUser._id, status: "open" });
        if (!openShift) {
          return res.status(403).json({
            message: `${waiterName}'s shift is closed. Open their shift in Settings before taking orders.`,
          });
        }
      }
    }

    const itemsWithSnapshot = items.map((i) => ({
      menuItemId: i.menuItemId || i._id || null,
      mealName: i.mealName,
      imageUrl: i.imageUrl || null,
      quantity: i.quantity,
      unitPrice: i.unitPrice,
      lineTotal: i.lineTotal,
      ready: false,
    }));

    // Staff-entered orders already have a waiter attached, so they go
    // straight into the kitchen queue instead of waiting on "pending".
    const order = await Order.create({
      tableNumber,
      waiterName,
      items: itemsWithSnapshot,
      subtotal,
      source: "staff",
      status: "serving",
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
    // Kitchen's live queue = orders actively being served. Online orders
    // only reach this state once a waiter has claimed them.
    const orders = await Order.find({ status: "serving" }).sort({ createdAt: 1 });
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

  const allowedStatuses = ["pending", "serving", "completed", "cancelled"];
  if (!allowedStatuses.includes(status)) {
    return res.status(400).json({ message: "Invalid status value" });
  }

  try {
    const update = { status };
    if (status === "completed") update.servedAt = new Date();
    if (status === "cancelled") update.cancelledAt = new Date();

    const order = await Order.findByIdAndUpdate(id, update, { new: true });

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

// @desc    Toggle a single item's "ready" state on a pending order (kitchen check-off)
// @route   PATCH /api/orders/:id/items/:itemIndex/ready
// @access  Protected — kitchen, manager, admin
export const toggleItemReady = async (req, res) => {
  const { id, itemIndex } = req.params;
  const { ready } = req.body;

  try {
    const order = await Order.findById(id);
    if (!order) return res.status(404).json({ message: "Order not found" });

    const idx = Number(itemIndex);
    if (!order.items[idx]) {
      return res.status(400).json({ message: "Item not found on this order" });
    }

    order.items[idx].ready = ready !== undefined ? !!ready : !order.items[idx].ready;
    await order.save();

    const io = req.app.get("io");
    io.emit("order:updated", order);

    res.json(order);
  } catch (error) {
    console.error("Error toggling item ready state:", error.message);
    res.status(500).json({ message: "Failed to update item", error: error.message });
  }
};

// @desc    A waiter claims an online order (assigns themselves as server of
//          record). This is the moment the order actually reaches the
//          kitchen — it moves from "pending" (awaiting a waiter) to
//          "serving" (in the kitchen queue), and the kitchen is notified
//          for the first time via order:created so its alarm fires once.
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
    if (order.status !== "pending") {
      return res.status(400).json({ message: "This order has already been taken" });
    }

    order.waiterName = waiterName;
    order.status = "serving";
    await order.save();

    const receipt = await Receipt.findOneAndUpdate(
      { order: order._id },
      { waiterName },
      { new: true }
    );

    const io = req.app.get("io");
    // First time the kitchen hears about this order — queues it + rings the alarm once
    io.emit("order:created", { order, receipt, source: "online" });
    // Customer + other waiter tabs sync on the status change (pending -> serving)
    io.emit("order:updated", order);

    res.json(order);
  } catch (error) {
    console.error("Error assigning order:", error.message);
    res.status(500).json({ message: "Failed to assign order", error: error.message });
  }
};

// @desc    Kitchen order history — filterable, searchable, paginated.
//          Includes every status so completed/cancelled tickets stay visible.
// @route   GET /api/orders/history?page=1&limit=25&status=&waiterName=&tableNumber=&search=&startDate=&endDate=
// @access  Protected — kitchen, manager, admin
export const getOrderHistory = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit) || 25));

    const query = {};

    if (req.query.status) query.status = req.query.status;
    if (req.query.waiterName) query.waiterName = new RegExp(req.query.waiterName, "i");
    if (req.query.tableNumber) query.tableNumber = req.query.tableNumber;

    if (req.query.startDate || req.query.endDate) {
      query.createdAt = {};
      if (req.query.startDate) query.createdAt.$gte = new Date(req.query.startDate);
      if (req.query.endDate) {
        // Treat endDate as inclusive of the whole day
        const end = new Date(req.query.endDate);
        end.setHours(23, 59, 59, 999);
        query.createdAt.$lte = end;
      }
    }

    if (req.query.search) {
      const re = new RegExp(req.query.search, "i");
      query.$or = [
        { waiterName: re },
        { customerName: re },
        { "items.mealName": re },
        { tableNumber: re },
      ];
    }

    const total = await Order.countDocuments(query);
    const orders = await Order.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    // Attach prep duration in seconds where we can compute it
    const withDuration = orders.map((o) => ({
      ...o,
      prepSeconds:
        o.servedAt && o.createdAt
          ? Math.round((new Date(o.servedAt) - new Date(o.createdAt)) / 1000)
          : null,
    }));

    res.json({
      orders: withDuration,
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (error) {
    console.error("Error fetching order history:", error.message);
    res.status(500).json({ message: "Failed to fetch order history", error: error.message });
  }
};

// @desc    Kitchen stats — orders served today + average prep time today
// @route   GET /api/orders/kitchen/stats
// @access  Protected — kitchen, manager, admin
export const getKitchenStats = async (req, res) => {
  try {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const servedToday = await Order.find({
      status: "completed",
      servedAt: { $gte: startOfDay },
    }).select("createdAt servedAt").lean();

    const count = servedToday.length;
    const avgPrepSeconds = count
      ? Math.round(
          servedToday.reduce(
            (sum, o) => sum + (new Date(o.servedAt) - new Date(o.createdAt)) / 1000,
            0
          ) / count
        )
      : 0;

    res.json({ servedToday: count, avgPrepSeconds });
  } catch (error) {
    console.error("Error fetching kitchen stats:", error.message);
    res.status(500).json({ message: "Failed to fetch kitchen stats", error: error.message });
  }
};

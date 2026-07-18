// controllers/customerOrderController.js
import Order from "../models/Order.js";
import Receipt from "../models/Receipt.js";
import { generateReceiptForOrder } from "../utils/generateReceipt.js";

// @desc    Place an order — public, no login, guest session
// @route   POST /api/orders/customer
// @access  Public
export const createCustomerOrder = async (req, res) => {
  const { tableNumber, items, guestSessionId, customerName } = req.body;

  if (!tableNumber) return res.status(400).json({ message: "Table number is required" });
  if (!guestSessionId) return res.status(400).json({ message: "Missing guest session" });
  if (!items || items.length === 0) return res.status(400).json({ message: "Cart is empty" });

  try {
    // Compute lineTotal server-side so the Order model's required field is always
    // satisfied, regardless of what the client sends.
    const itemsWithTotals = items.map((i) => ({
      mealName: i.mealName,
      quantity: i.quantity,
      unitPrice: i.unitPrice,
      lineTotal: i.quantity * i.unitPrice,
    }));

    const subtotal = itemsWithTotals.reduce((sum, i) => sum + i.lineTotal, 0);

    const order = await Order.create({
      tableNumber,
      waiterName: null,
      items: itemsWithTotals,
      subtotal,
      status: "pending",
      source: "online",
      guestSessionId,
      customerName: customerName || null,
    });

    const receipt = await generateReceiptForOrder(order);

    const io = req.app.get("io");
    io.emit("order:created", { order, receipt, source: "online" });

    res.status(201).json({ order, receipt, billId: receipt.billId });
  } catch (error) {
    console.error("Error creating customer order:", error.message);
    res.status(500).json({ message: "Failed to place order", error: error.message });
  }
};

// @desc    Get a guest's own orders, with their bill ID attached
// @route   GET /api/orders/customer?sessionId=xxx
// @access  Public
export const getCustomerOrders = async (req, res) => {
  const { sessionId } = req.query;
  if (!sessionId) return res.status(400).json({ message: "sessionId is required" });

  try {
    const orders = await Order.find({ guestSessionId: sessionId })
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();

    const orderIds = orders.map((o) => o._id);
    const receipts = await Receipt.find({ order: { $in: orderIds } }).select("order billId").lean();
    const billIdByOrder = Object.fromEntries(receipts.map((r) => [String(r.order), r.billId]));

    res.json(orders.map((o) => ({ ...o, billId: billIdByOrder[String(o._id)] || null })));
  } catch (error) {
    console.error("Error fetching customer orders:", error.message);
    res.status(500).json({ message: "Failed to fetch orders" });
  }
};

// @desc    Cancel a guest's own pending order
// @route   PATCH /api/orders/customer/:id/cancel
// @access  Public — guarded by guest session match
export const cancelCustomerOrder = async (req, res) => {
  const { id } = req.params;
  const { sessionId } = req.body;

  try {
    const order = await Order.findById(id);

    if (!order) return res.status(404).json({ message: "Order not found" });
    if (order.guestSessionId !== sessionId) {
      return res.status(403).json({ message: "Not authorized to cancel this order" });
    }
    if (order.status !== "pending") {
      return res.status(400).json({ message: "Only pending orders can be cancelled" });
    }

    order.status = "cancelled";
    await order.save();

    const io = req.app.get("io");
    io.emit("order:updated", order);

    res.json(order);
  } catch (error) {
    console.error("Error cancelling order:", error.message);
    res.status(500).json({ message: "Failed to cancel order" });
  }
};

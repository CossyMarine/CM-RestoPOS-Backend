// controllers/customerOrderController.js
import Order from "../models/Order.js";
import Receipt from "../models/Receipt.js";
import { generateReceiptForOrder } from "../utils/generateReceipt.js";

// @desc    Place an order — customer must be logged in (registered account)
// @route   POST /api/orders/customer
// @access  Protected — customer
export const createCustomerOrder = async (req, res) => {
  const { tableNumber, items } = req.body;

  if (!tableNumber) return res.status(400).json({ message: "Table number is required" });
  if (!items || items.length === 0) return res.status(400).json({ message: "Cart is empty" });

  try {
    const itemsWithTotals = items.map((i) => ({
      menuItemId: i.menuItemId || i.id || null,
      mealName: i.mealName,
      imageUrl: i.imageUrl || null,
      quantity: i.quantity,
      unitPrice: i.unitPrice,
      lineTotal: i.quantity * i.unitPrice,
      ready: false,
    }));

    const subtotal = itemsWithTotals.reduce((sum, i) => sum + i.lineTotal, 0);

    const order = await Order.create({
      tableNumber,
      waiterName: null,
      items: itemsWithTotals,
      subtotal,
      status: "pending", // awaiting a waiter to take it — NOT in the kitchen queue yet
      source: "online",
      customer: req.user._id,
      customerName: req.user.fullName,
    });

    const receipt = await generateReceiptForOrder(order, { customer: req.user._id });

    const io = req.app.get("io");
    // Only the waiter dashboard listens for this — the kitchen does not,
    // so the order does not reach the kitchen until a waiter takes it.
    io.emit("onlineOrder:new", { order, receipt });

    res.status(201).json({ order, receipt, billId: receipt.billId });
  } catch (error) {
    console.error("Error creating customer order:", error.message);
    res.status(500).json({ message: "Failed to place order", error: error.message });
  }
};

// @desc    Get the logged-in customer's own order history, with bill ID and
//          payment status attached, newest first
// @route   GET /api/orders/customer?page=1&limit=20
// @access  Protected — customer
export const getCustomerOrders = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, parseInt(req.query.limit) || 20);

    const total = await Order.countDocuments({ customer: req.user._id });
    const orders = await Order.find({ customer: req.user._id })
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    const orderIds = orders.map((o) => o._id);
    const receipts = await Receipt.find({ order: { $in: orderIds } })
      .select("order billId status amountPaid subtotal pendingManualPayments")
      .lean();
    const receiptByOrder = Object.fromEntries(receipts.map((r) => [String(r.order), r]));

    res.json({
      orders: orders.map((o) => {
        const receipt = receiptByOrder[String(o._id)] || null;
        return {
          ...o,
          billId: receipt?.billId || null,
          billStatus: receipt?.status || null,
          amountPaid: receipt?.amountPaid || 0,
          billHasPendingPayment: (receipt?.pendingManualPayments?.length || 0) > 0,
        };
      }),
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (error) {
    console.error("Error fetching customer orders:", error.message);
    res.status(500).json({ message: "Failed to fetch orders" });
  }
};

// @desc    Cancel the logged-in customer's own pending order
// @route   PATCH /api/orders/customer/:id/cancel
// @access  Protected — customer
export const cancelCustomerOrder = async (req, res) => {
  const { id } = req.params;

  try {
    const order = await Order.findById(id);

    if (!order) return res.status(404).json({ message: "Order not found" });
    if (String(order.customer) !== String(req.user._id)) {
      return res.status(403).json({ message: "Not authorized to cancel this order" });
    }
    if (order.status !== "pending") {
      return res.status(400).json({ message: "Only pending orders can be cancelled" });
    }

    order.status = "cancelled";
    order.cancelledAt = new Date();
    await order.save();

    const io = req.app.get("io");
    io.emit("order:updated", order);

    res.json(order);
  } catch (error) {
    console.error("Error cancelling order:", error.message);
    res.status(500).json({ message: "Failed to cancel order" });
  }
};

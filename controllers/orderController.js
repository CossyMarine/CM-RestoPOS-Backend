// controllers/orderController.js
import Order from "../models/Order.js";
import Receipt from "../models/Receipt.js";
import Shift from "../models/Shift.js";
import User from "../models/User.js";
import MenuItem from "../models/MenuItem.js";
import { generateReceiptForOrder } from "../utils/generateReceipt.js";
import { getKenyanDayBounds } from "../utils/dateHelpers.js";
import mongoose from "mongoose";
// @desc    Create a new order and receipt (staff/manual entry)
// @route   POST /api/orders
// @access  Protected — cashier, manager, admin, waiter
// @desc    Create a new order and receipt (staff/manual entry)
// @route   POST /api/orders
// @access  Protected — cashier, manager, admin, waiter
export const createOrder = async (req, res) => {
  const { businessId } = req;
  const { tableNumber, waiterName, items, clientRequestId } = req.body;

  if (!items || items.length === 0) {
    return res.status(400).json({ message: "Order must have at least one item" });
  }

  const session = await mongoose.startSession();

  try {
    let result;

    await session.withTransaction(async () => {
      // A response may have been lost after a successful commit. Return the
      // prior order and repair a legacy/orphaned receipt if one is absent.
      if (clientRequestId) {
        const existingOrder = await Order.findOne({
          businessId,
          clientRequestId,
        }).session(session);

        if (existingOrder) {
          let existingReceipt = await Receipt.findOne({
            businessId,
            order: existingOrder._id,
          }).session(session);

          if (!existingReceipt) {
            existingReceipt = await generateReceiptForOrder(existingOrder, {
              session,
            });
          }

          result = {
            order: existingOrder,
            receipt: existingReceipt,
            deduped: true,
          };

          return;
        }
      }

      const menuItemIds = items
        .map((item) => item.menuItemId || item._id)
        .filter(Boolean);

      const menuItems = menuItemIds.length
        ? await MenuItem.find({
            _id: { $in: menuItemIds },
            businessId,
          }).session(session)
        : [];

      const menuItemsById = new Map(
        menuItems.map((item) => [String(item._id), item])
      );

      const itemsWithSnapshot = items.map((item) => {
        const menuItemId = item.menuItemId || item._id || null;
        const quantity = Number(item.quantity);

        if (!Number.isFinite(quantity) || quantity <= 0) {
          throw new Error(`Invalid quantity for ${item.mealName || "an item"}`);
        }

        if (menuItemId) {
          const menuItem = menuItemsById.get(String(menuItemId));

          if (!menuItem) {
            throw new Error(`Menu item not found: ${menuItemId}`);
          }

          return {
            menuItemId: menuItem._id,
            mealName: menuItem.name,
            imageUrl: menuItem.imageUrl || null,
            quantity,
            unitPrice: menuItem.price,
            lineTotal: Number((menuItem.price * quantity).toFixed(2)),
            ready: false,
          };
        }

        const unitPrice = Number(item.unitPrice);

        if (!Number.isFinite(unitPrice) || unitPrice < 0) {
          throw new Error(`Invalid price for ${item.mealName || "a manual item"}`);
        }

        return {
          menuItemId: null,
          mealName: item.mealName,
          imageUrl: item.imageUrl || null,
          quantity,
          unitPrice,
          lineTotal: Number((unitPrice * quantity).toFixed(2)),
          ready: false,
        };
      });

      const subtotal = Number(
        itemsWithSnapshot
          .reduce((sum, item) => sum + item.lineTotal, 0)
          .toFixed(2)
      );

      const order = new Order({
        businessId,
        tableNumber,
        waiterName,
        items: itemsWithSnapshot,
        subtotal,
        source: "staff",
        status: "serving",
        clientRequestId: clientRequestId || null,
      });

      await order.save({ session });

      const receipt = await generateReceiptForOrder(order, { session });

      result = {
        order,
        receipt,
        deduped: false,
      };
    });

    const io = req.app.get("io");

    if (!result.deduped) {
      io.emit("order:created", {
        order: result.order,
        receipt: result.receipt,
        source: "staff",
      });
    }

    return res.status(result.deduped ? 200 : 201).json({
      order: result.order,
      receipt: result.receipt,
      items: result.order.items,
      deduped: result.deduped,
    });
  } catch (error) {
    // A concurrent request can hit the Order unique index. Resolve it to
    // the already-created sale rather than producing a duplicate/error.
    if (error.code === 11000 && clientRequestId) {
      const existingOrder = await Order.findOne({ businessId, clientRequestId });
      const existingReceipt = existingOrder
        ? await Receipt.findOne({
            businessId,
            order: existingOrder._id,
          })
        : null;

      if (existingOrder && existingReceipt) {
        return res.status(200).json({
          order: existingOrder,
          receipt: existingReceipt,
          items: existingOrder.items,
          deduped: true,
        });
      }
    }

    console.error("Error creating order:", error.message);

    return res.status(500).json({
      message: error.message || "Failed to create order",
    });
  } finally {
    await session.endSession();
  }
};

// @desc    Get all orders the kitchen hasn't finished
// @route   GET /api/orders/pending
// @access  Protected
export const getPendingOrders = async (req, res) => {
  try {
    const { businessId } = req;
    // Kitchen's live queue = orders actively being served. Online orders
    // only reach this state once a waiter has claimed them.
    const orders = await Order.find({ status: "serving", businessId }).sort({ createdAt: 1 });
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
  const { businessId } = req;
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

    const order = await Order.findOneAndUpdate({ _id: id, businessId }, update, { new: true });

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
  const { businessId } = req;
  const { id, itemIndex } = req.params;
  const { ready } = req.body;

  try {
    const order = await Order.findOne({ _id: id, businessId });
    if (!order) return res.status(404).json({ message: "Order not found" });

    const idx = Number(itemIndex);
    if (!order.items[idx]) {
      return res.status(400).json({ message: "Item not found on this order" });
    }

    order.items[idx].ready = ready !== undefined ? !!ready : !order.items[idx].ready;
    await order.save();

    const io = req.app.get("io");
    io.emit("order:updated", order);

    // Tell the waiter who owns this table specifically — only when an item
    // just became ready, not when the kitchen unchecks it by mistake.
    if (order.items[idx].ready) {
      io.emit("order:itemReady", {
        orderId: order._id,
        tableNumber: order.tableNumber,
        waiterName: order.waiterName,
        mealName: order.items[idx].mealName,
        quantity: order.items[idx].quantity,
      });
    }

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
  const { businessId } = req;
  const { id } = req.params;
  const { waiterName } = req.body;

  if (!waiterName) {
    return res.status(400).json({ message: "waiterName is required" });
  }

  try {
    const order = await Order.findOne({ _id: id, businessId });
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
      { order: order._id, businessId },
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
    const { businessId } = req;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit) || 25));

    const query = { businessId };

    if (req.query.status) query.status = req.query.status;
    if (req.query.waiterName) query.waiterName = new RegExp(req.query.waiterName, "i");
    if (req.query.tableNumber) query.tableNumber = req.query.tableNumber;

    if (req.query.startDate || req.query.endDate) {
      query.createdAt = {};
      // Both bounds are anchored to the Kenyan calendar day the picker value
      // falls on, not the server's local timezone.
      if (req.query.startDate) {
        query.createdAt.$gte = getKenyanDayBounds(req.query.startDate).start;
      }
      if (req.query.endDate) {
        // Treat endDate as inclusive of the whole Kenyan day
        query.createdAt.$lte = getKenyanDayBounds(req.query.endDate).end;
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
    const { businessId } = req;
    const { start: startOfDay } = getKenyanDayBounds();

    const servedToday = await Order.find({
      businessId,
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
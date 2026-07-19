// controllers/receiptController.js
import Receipt from "../models/Receipt.js";
import Order from "../models/Order.js";

// @desc    Mark a receipt as paid
// @route   PATCH /api/receipts/:id/pay
// @access  Protected — admin
export const payReceipt = async (req, res) => {
  const { id } = req.params;
  const { paymentMethod, amountPaid } = req.body;

  try {
    const receipt = await Receipt.findById(id);

    if (!receipt) {
      return res.status(404).json({ message: "Receipt not found" });
    }
    if (receipt.status !== "unpaid") {
      return res.status(400).json({ message: "Receipt is already paid or voided" });
    }

    const changeGiven = amountPaid - receipt.subtotal;

    receipt.status = "paid";
    receipt.paymentMethod = paymentMethod;
    receipt.amountPaid = amountPaid;
    receipt.changeGiven = changeGiven;
    receipt.paidAt = new Date();
    await receipt.save();

    await Order.findByIdAndUpdate(receipt.order, { status: "completed" });

    const io = req.app.get("io");
    io.emit("receipt:paid", receipt);

    res.json({ message: "Payment successful", receipt });
  } catch (error) {
    console.error("Error processing payment:", error.message);
    res.status(500).json({ message: "Failed to process payment", error: error.message });
  }
};

// @desc    Get all unpaid receipts
// @route   GET /api/receipts
// @access  Protected — admin
export const getReceipts = async (req, res) => {
  try {
    const receipts = await Receipt.find({ status: "unpaid" }).sort({ createdAt: -1 });
    res.json(receipts);
  } catch (error) {
    console.error("Error fetching receipts:", error.message);
    res.status(500).json({ message: "Failed to fetch receipts" });
  }
};

// @desc    Get paid receipts (most recent first) — accountant view
// @route   GET /api/receipts/paid
// @access  Protected — admin, accountant
export const getPaidReceipts = async (req, res) => {
  try {
    const receipts = await Receipt.find({ status: "paid" }).sort({ paidAt: -1 }).limit(200);
    res.json(receipts);
  } catch (error) {
    console.error("Error fetching paid receipts:", error.message);
    res.status(500).json({ message: "Failed to fetch paid receipts" });
  }
};

// @desc    Get unpaid receipts for a specific waiter
// @route   GET /api/receipts/waiter/:name
// @access  Protected
export const getReceiptsByWaiter = async (req, res) => {
  try {
    const { name } = req.params;
    const receipts = await Receipt.find({ waiterName: name, status: "unpaid" }).sort({
      createdAt: -1,
    });
    res.json(receipts);
  } catch (error) {
    console.error("Error fetching receipts by waiter:", error.message);
    res.status(500).json({ message: "Failed to fetch receipts" });
  }
};

// @desc    Get a single receipt (used for print / add-items refresh)
// @route   GET /api/receipts/:id
// @access  Protected
export const getReceiptById = async (req, res) => {
  try {
    const receipt = await Receipt.findById(req.params.id);
    if (!receipt) return res.status(404).json({ message: "Receipt not found" });
    res.json(receipt);
  } catch (error) {
    console.error("Error fetching receipt:", error.message);
    res.status(500).json({ message: "Failed to fetch receipt" });
  }
};

// @desc    Paginated bill history for one waiter, every status, newest first
// @desc    Paginated bill history across ALL waiters, every status, newest first
//         (used by the Bill Records tab when no waiter is selected)
// @route   GET /api/receipts/history?page=1&limit=4&q=search
// @access  Protected
export const getReceiptHistory = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, parseInt(req.query.limit) || 4);
    const q = (req.query.q || "").trim();

    const filter = {};
    if (q) {
      const orClauses = [
        { billId: { $regex: q, $options: "i" } },
        { waiterName: { $regex: q, $options: "i" } },
      ];
      orClauses.push(
        isNaN(q) ? { tableNumber: { $regex: q, $options: "i" } } : { tableNumber: q }
      );
      filter.$or = orClauses;
    }

    const total = await Receipt.countDocuments(filter);
    const receipts = await Receipt.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit);

    res.json({
      receipts,
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (error) {
    console.error("Error fetching bill history:", error.message);
    res.status(500).json({ message: "Failed to fetch bill history" });
  }
};

// @desc    Add items to an unpaid bill (customer wants to order more before paying)
// @route   PATCH /api/receipts/:id/items
// @access  Protected — waiter, manager, admin, cashier
export const addItemsToReceipt = async (req, res) => {
  const { id } = req.params;
  const { items } = req.body;

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ message: "At least one item is required" });
  }

  try {
    const receipt = await Receipt.findById(id);
    if (!receipt) return res.status(404).json({ message: "Receipt not found" });
    if (receipt.status !== "unpaid") {
      return res.status(400).json({ message: "Only unpaid bills can be added to" });
    }

    const merged = [...receipt.items];
    items.forEach((incoming) => {
      const lineTotal = incoming.quantity * incoming.unitPrice;
      const existing = merged.find(
        (i) => i.mealName === incoming.mealName && i.unitPrice === incoming.unitPrice
      );
      if (existing) {
        existing.quantity += incoming.quantity;
        existing.lineTotal += lineTotal;
      } else {
        merged.push({
          mealName: incoming.mealName,
          quantity: incoming.quantity,
          unitPrice: incoming.unitPrice,
          lineTotal,
        });
      }
    });

    const subtotal = merged.reduce((sum, i) => sum + i.lineTotal, 0);

    receipt.items = merged;
    receipt.subtotal = subtotal;
    await receipt.save();

    const order = await Order.findByIdAndUpdate(
      receipt.order,
      { items: merged, subtotal },
      { new: true }
    );

    const io = req.app.get("io");
    io.emit("receipt:updated", receipt);
    if (order) io.emit("order:updated", order);

    res.json(receipt);
  } catch (error) {
    console.error("Error adding items to receipt:", error.message);
    res.status(500).json({ message: "Failed to add items", error: error.message });
  }
};

// @desc    Record that a receipt was (re)printed
// @route   PATCH /api/receipts/:id/print
// @access  Protected
export const markReceiptPrinted = async (req, res) => {
  try {
    const receipt = await Receipt.findByIdAndUpdate(
      req.params.id,
      { $inc: { printCount: 1 }, $set: { printedAt: new Date() } },
      { new: true }
    );
    if (!receipt) return res.status(404).json({ message: "Receipt not found" });
    res.json(receipt);
  } catch (error) {
    console.error("Error marking receipt printed:", error.message);
    res.status(500).json({ message: "Failed to update print status" });
  }
};

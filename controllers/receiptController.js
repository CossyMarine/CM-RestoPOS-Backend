// controllers/receiptController.js
import Receipt from "../models/Receipt.js";
import Order from "../models/Order.js";
import { stkPush, stkQuery } from "../utils/mpesa.js";

// ============================================================
// CASH PAYMENT
// ============================================================

// @desc    Pay a receipt with cash. Change is never allowed to be negative.
// @route   PATCH /api/receipts/:id/pay
// @access  Protected — admin
export const payReceipt = async (req, res) => {
  const { id } = req.params;
  const { amountPaid } = req.body;

  try {
    const receipt = await Receipt.findById(id);
    if (!receipt) return res.status(404).json({ message: "Receipt not found" });
    if (receipt.status !== "unpaid") {
      return res.status(400).json({ message: "Receipt is already paid or voided" });
    }

    const received = parseFloat(amountPaid);
    if (isNaN(received) || received <= 0) {
      return res.status(400).json({ message: "Enter a valid amount received" });
    }

    const changeGiven = Number((received - receipt.subtotal).toFixed(2));
    if (changeGiven < 0) {
      return res.status(400).json({
        message: `Amount received (KES ${received}) is less than the bill (KES ${receipt.subtotal}). Change cannot be negative.`,
      });
    }

    receipt.status = "paid";
    receipt.paymentMethod = "cash";
    receipt.cashAmount = received;
    receipt.tillAmount = 0;
    receipt.amountPaid = received;
    receipt.changeGiven = changeGiven;
    receipt.paidAt = new Date();
    receipt.mpesaStatus = "idle";
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

// ============================================================
// M-PESA (TILL) PAYMENT — STK PUSH
// ============================================================

// Shared: mark a receipt paid once Daraja confirms success
const finalizeMpesaSuccess = async ({ receipt, mpesaReceiptNumber, io }) => {
  const cashAmount = receipt.pendingCashAmount || 0;
  const tillAmount = receipt.pendingTillAmount || 0;

  receipt.status = "paid";
  receipt.paymentMethod = cashAmount > 0 ? "both" : "mpesa_till";
  receipt.cashAmount = cashAmount;
  receipt.tillAmount = tillAmount;
  receipt.amountPaid = Number((cashAmount + tillAmount).toFixed(2));
  receipt.changeGiven = 0;
  receipt.paidAt = new Date();
  receipt.mpesaStatus = "success";
  receipt.mpesaReceiptNumber = mpesaReceiptNumber || receipt.mpesaReceiptNumber || null;
  receipt.mpesaResultDesc = "Payment received successfully";
  await receipt.save();

  await Order.findByIdAndUpdate(receipt.order, { status: "completed" });

  io.emit("receipt:paid", receipt);
  io.emit("mpesa:result", {
    checkoutRequestId: receipt.mpesaCheckoutRequestId,
    status: "success",
    receipt,
  });
};

const finalizeMpesaFailure = async ({ receipt, resultDesc, io }) => {
  receipt.mpesaStatus = "failed";
  receipt.mpesaResultDesc = resultDesc || "Payment was not completed";
  await receipt.save();

  io.emit("mpesa:result", {
    checkoutRequestId: receipt.mpesaCheckoutRequestId,
    status: "failed",
    message: receipt.mpesaResultDesc,
  });
};

// @desc    Trigger an STK push. cashAmount = 0 for till-only, or a partial
//          amount for a split "both" payment (till covers the remainder).
// @route   POST /api/receipts/:id/mpesa/initiate
// @access  Protected — admin
export const initiateMpesaPayment = async (req, res) => {
  const { id } = req.params;
  let { phone, cashAmount } = req.body;

  try {
    const receipt = await Receipt.findById(id);
    if (!receipt) return res.status(404).json({ message: "Receipt not found" });
    if (receipt.status !== "unpaid") {
      return res.status(400).json({ message: "Receipt is already paid or voided" });
    }
    if (!phone) {
      return res.status(400).json({ message: "M-Pesa phone number is required" });
    }

    cashAmount = parseFloat(cashAmount) || 0;
    if (cashAmount < 0) {
      return res.status(400).json({ message: "Cash amount cannot be negative" });
    }
    if (cashAmount >= receipt.subtotal) {
      return res.status(400).json({
        message: "Cash amount covers the full bill — use Cash payment instead",
      });
    }

    const tillAmount = Number((receipt.subtotal - cashAmount).toFixed(2));

    const stkRes = await stkPush({
      phone,
      amount: tillAmount,
      accountRef: receipt.billId,
      description: `Bill ${receipt.billId}`,
    });

    if (String(stkRes.ResponseCode) !== "0") {
      return res.status(400).json({
        message: stkRes.ResponseDescription || "Failed to initiate M-Pesa payment",
      });
    }

    receipt.mpesaPhone = phone;
    receipt.mpesaCheckoutRequestId = stkRes.CheckoutRequestID;
    receipt.mpesaMerchantRequestId = stkRes.MerchantRequestID;
    receipt.mpesaStatus = "pending";
    receipt.mpesaResultDesc = null;
    receipt.mpesaReceiptNumber = null;
    receipt.pendingCashAmount = cashAmount;
    receipt.pendingTillAmount = tillAmount;
    await receipt.save();

    const io = req.app.get("io");
    io.emit("receipt:mpesaPending", receipt);

    res.json({
      message: "STK push sent. Ask the customer to enter their M-Pesa PIN.",
      checkoutRequestId: stkRes.CheckoutRequestID,
      tillAmount,
      cashAmount,
    });
  } catch (error) {
    console.error("Error initiating M-Pesa payment:", error.response?.data || error.message);
    res.status(500).json({
      message:
        error.response?.data?.errorMessage ||
        error.message ||
        "Failed to initiate M-Pesa payment",
    });
  }
};

// @desc    Daraja calls this once the customer responds to the STK prompt
// @route   POST /api/receipts/mpesa/callback
// @access  Public (Safaricom webhook)
export const mpesaCallback = async (req, res) => {
  try {
    const callback = req.body?.Body?.stkCallback;
    if (!callback) return res.status(200).json({ message: "Ignored" });

    const { CheckoutRequestID, ResultCode, ResultDesc, CallbackMetadata } = callback;

    const receipt = await Receipt.findOne({ mpesaCheckoutRequestId: CheckoutRequestID });
    if (!receipt || receipt.status !== "unpaid") {
      return res.status(200).json({ message: "Receipt not found or already settled" });
    }

    const io = req.app.get("io");

    if (Number(ResultCode) === 0) {
      const items = CallbackMetadata?.Item || [];
      const receiptNumberItem = items.find((i) => i.Name === "MpesaReceiptNumber");
      await finalizeMpesaSuccess({
        receipt,
        mpesaReceiptNumber: receiptNumberItem?.Value || null,
        io,
      });
    } else {
      await finalizeMpesaFailure({ receipt, resultDesc: ResultDesc, io });
    }

    res.status(200).json({ message: "Callback processed" });
  } catch (error) {
    console.error("M-Pesa callback error:", error.message);
    // Always 200 so Safaricom doesn't retry-storm us
    res.status(200).json({ message: "Callback error logged" });
  }
};

// @desc    Poll payment status. Also actively queries Daraja, so payment
//          still completes even if the callback URL can't be reached
//          (e.g. local development without a public URL).
// @route   GET /api/receipts/:id/mpesa/status
// @access  Protected — admin
export const getMpesaStatus = async (req, res) => {
  try {
    const receipt = await Receipt.findById(req.params.id);
    if (!receipt) return res.status(404).json({ message: "Receipt not found" });

    if (receipt.status === "paid") {
      return res.json({ status: "success", receipt });
    }
    if (receipt.mpesaStatus !== "pending" || !receipt.mpesaCheckoutRequestId) {
      return res.json({ status: receipt.mpesaStatus || "idle", receipt });
    }

    const io = req.app.get("io");

    try {
      const queryRes = await stkQuery(receipt.mpesaCheckoutRequestId);
      const resultCode = Number(queryRes.ResultCode);

      if (resultCode === 0) {
        await finalizeMpesaSuccess({ receipt, mpesaReceiptNumber: null, io });
        return res.json({ status: "success", receipt });
      }
      if (!isNaN(resultCode)) {
        await finalizeMpesaFailure({ receipt, resultDesc: queryRes.ResultDesc, io });
        return res.json({ status: "failed", message: queryRes.ResultDesc, receipt });
      }
    } catch (queryErr) {
      // Safaricom often 500s this while the customer is still entering their PIN — keep polling.
      console.warn("M-Pesa status query still pending:", queryErr.response?.data || queryErr.message);
    }

    res.json({ status: "pending", receipt });
  } catch (error) {
    console.error("Error checking M-Pesa status:", error.message);
    res.status(500).json({ message: "Failed to check payment status" });
  }
};

// @desc    Cancel a pending STK push so the cashier can retry or switch method
// @route   POST /api/receipts/:id/mpesa/cancel
// @access  Protected — admin
export const cancelMpesaPayment = async (req, res) => {
  try {
    const receipt = await Receipt.findById(req.params.id);
    if (!receipt) return res.status(404).json({ message: "Receipt not found" });

    receipt.mpesaStatus = "idle";
    receipt.mpesaCheckoutRequestId = null;
    receipt.mpesaMerchantRequestId = null;
    receipt.mpesaResultDesc = null;
    receipt.pendingCashAmount = 0;
    receipt.pendingTillAmount = 0;
    await receipt.save();

    res.json({ message: "Cancelled", receipt });
  } catch (error) {
    console.error("Error cancelling M-Pesa payment:", error.message);
    res.status(500).json({ message: "Failed to cancel" });
  }
};

// ============================================================
// LISTS / HISTORY / SUMMARY
// ============================================================

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

// @desc    Today's paid vs unpaid totals — powers the "All" tab summary bar
// @route   GET /api/receipts/summary/today
// @access  Protected — admin, accountant
export const getReceiptsTodaySummary = async (req, res) => {
  try {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);

    const [paidAgg, unpaidAgg] = await Promise.all([
      Receipt.aggregate([
        { $match: { status: "paid", paidAt: { $gte: startOfDay, $lte: endOfDay } } },
        { $group: { _id: null, total: { $sum: "$subtotal" }, count: { $sum: 1 } } },
      ]),
      Receipt.aggregate([
        { $match: { status: "unpaid", createdAt: { $gte: startOfDay, $lte: endOfDay } } },
        { $group: { _id: null, total: { $sum: "$subtotal" }, count: { $sum: 1 } } },
      ]),
    ]);

    res.json({
      paidToday: paidAgg[0]?.total || 0,
      paidTodayCount: paidAgg[0]?.count || 0,
      unpaidToday: unpaidAgg[0]?.total || 0,
      unpaidTodayCount: unpaidAgg[0]?.count || 0,
    });
  } catch (error) {
    console.error("Error fetching today's summary:", error.message);
    res.status(500).json({ message: "Failed to fetch summary" });
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

// @desc    Paginated bill history across ALL waiters, every status, newest first.
//          Supports search (billId / waiter / table) and a createdAt date range.
//          Default page size is 10.
// @route   GET /api/receipts/history?page=1&limit=10&q=search&from=ISO&to=ISO
// @access  Protected
export const getReceiptHistory = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, parseInt(req.query.limit) || 10);
    const q = (req.query.q || "").trim();
    const { from, to } = req.query;

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
    if (from || to) {
      filter.createdAt = {};
      if (from) filter.createdAt.$gte = new Date(from);
      if (to) filter.createdAt.$lte = new Date(to);
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

// @desc    Paginated bill history for one waiter, every status, newest first
// @route   GET /api/receipts/waiter/:name/history?page=1&limit=4&q=search&from=ISO&to=ISO
// @access  Protected
export const getReceiptHistoryByWaiter = async (req, res) => {
  try {
    const { name } = req.params;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, parseInt(req.query.limit) || 4);
    const q = (req.query.q || "").trim();
    const { from, to } = req.query;

    const filter = { waiterName: name };
    if (q) {
      const orClauses = [{ billId: { $regex: q, $options: "i" } }];
      orClauses.push(
        isNaN(q) ? { tableNumber: { $regex: q, $options: "i" } } : { tableNumber: q }
      );
      filter.$or = orClauses;
    }
    if (from || to) {
      filter.createdAt = {};
      if (from) filter.createdAt.$gte = new Date(from);
      if (to) filter.createdAt.$lte = new Date(to);
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

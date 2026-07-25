// controllers/receipt/receiptQueries.js
import Receipt from "../../models/Receipt.js";

// Online orders that no waiter has claimed yet shouldn't clutter the
// normal admin tabs — they live in the "Pending Online" tab instead
// until a waiter (or admin) assigns themselves via /orders/:id/assign.
const excludeUnclaimedOnline = {
  $or: [{ source: { $ne: "online" } }, { waiterName: { $ne: null } }],
};

// @desc    Get all unpaid or partially-paid receipts
// @route   GET /api/receipts
// @access  Protected — admin
export const getReceipts = async (req, res) => {
  try {
    const receipts = await Receipt.find({
      status: { $in: ["unpaid", "partial"] },
      ...excludeUnclaimedOnline,
    }).sort({ createdAt: -1 });
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
    const receipts = await Receipt.find({
      status: "paid",
      ...excludeUnclaimedOnline,
    }).sort({ paidAt: -1 }).limit(200);
    res.json(receipts);
  } catch (error) {
    console.error("Error fetching paid receipts:", error.message);
    res.status(500).json({ message: "Failed to fetch paid receipts" });
  }
};

// @desc    Online orders placed by customers that no waiter has claimed yet
// @route   GET /api/receipts/online-pending
// @access  Protected — admin
export const getPendingOnlineReceipts = async (req, res) => {
  try {
    const receipts = await Receipt.find({
      source: "online",
      waiterName: null,
    }).sort({ createdAt: 1 });
    res.json(receipts);
  } catch (error) {
    console.error("Error fetching pending online receipts:", error.message);
    res.status(500).json({ message: "Failed to fetch pending online receipts" });
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
        { $match: { status: { $in: ["unpaid", "partial"] }, createdAt: { $gte: startOfDay, $lte: endOfDay } } },
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

// @desc    Get unpaid/partial receipts for a specific waiter
// @route   GET /api/receipts/waiter/:name
// @access  Protected
export const getReceiptsByWaiter = async (req, res) => {
  try {
    const { name } = req.params;
    const receipts = await Receipt.find({ waiterName: name, status: { $in: ["unpaid", "partial"] } }).sort({
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
    const receipt = await Receipt.findById(req.params.id)
      .populate("payments.paidBy", "fullName email phone isAdmin role")
      .populate("pendingManualPayments.paidBy", "fullName email phone isAdmin role")
      .populate("customer", "fullName email phone role");
    if (!receipt) return res.status(404).json({ message: "Receipt not found" });
    res.json(receipt);
  } catch (error) {
    console.error("Error fetching receipt:", error.message);
    res.status(500).json({ message: "Failed to fetch receipt" });
  }
};

// @desc    Paginated bill history across ALL waiters, every status, newest first.
// @route   GET /api/receipts/history?page=1&limit=10&q=search&from=ISO&to=ISO
// @access  Protected
export const getReceiptHistory = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, parseInt(req.query.limit) || 10);
    const q = (req.query.q || "").trim();
    const { from, to } = req.query;

    const filter = { ...excludeUnclaimedOnline };
    if (q) {
      const orClauses = [
        { billId: { $regex: q, $options: "i" } },
        { waiterName: { $regex: q, $options: "i" } },
      ];
      orClauses.push(
        isNaN(q) ? { tableNumber: { $regex: q, $options: "i" } } : { tableNumber: q }
      );
      // filter already has $or from excludeUnclaimedOnline — combine with $and
      filter.$and = [{ $or: orClauses }];
      delete filter.$or;
      filter.$and.push({ $or: excludeUnclaimedOnline.$or });
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

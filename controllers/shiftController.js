// controllers/shiftController.js
import Shift from "../models/Shift.js";
import PettyCash from "../models/PettyCash.js";
import Receipt from "../models/Receipt.js";
import VoidRequest from "../models/VoidRequest.js";

// @desc    Open a shift for the logged-in user. Each staff member (accountant,
//          waiter, etc.) has their own shift now — the uniqueness check is
//          scoped per-user, not restaurant-wide.
// @route   POST /api/shifts/open
// @access  Protected
export const openShift = async (req, res) => {
  const { openingFloat } = req.body;
  const openedBy = req.user._id;

  if (openingFloat === undefined || openingFloat === null || isNaN(openingFloat)) {
    return res.status(400).json({ message: "openingFloat is required and must be a number" });
  }

  try {
    const existing = await Shift.findOne({ openedBy, status: "open" });
    if (existing) {
      return res.status(400).json({ message: "You already have a shift open", shift: existing });
    }

    const shift = await Shift.create({ openedBy, openingFloat });

    const io = req.app.get("io");
    io.emit("shift:opened", shift);

    res.status(201).json(shift);
  } catch (error) {
    console.error("Error opening shift:", error.message);
    res.status(500).json({ message: "Failed to open shift", error: error.message });
  }
};

// @desc    Get the logged-in user's own open shift, or null
// @route   GET /api/shifts/current
// @access  Protected
export const getCurrentShift = async (req, res) => {
  try {
    const shift = await Shift.findOne({ openedBy: req.user._id, status: "open" }).populate("openedBy", "fullName");
    res.json(shift);
  } catch (error) {
    console.error("Error fetching current shift:", error.message);
    res.status(500).json({ message: "Failed to fetch current shift", error: error.message });
  }
};

// @desc    Log a petty cash out-payment against an open shift (must be yours, unless admin)
// @route   POST /api/shifts/:id/petty-cash
// @access  Protected
export const addPettyCash = async (req, res) => {
  const { id } = req.params;
  const { amount, reason } = req.body;
  const loggedBy = req.user._id;

  if (!amount || isNaN(amount) || amount <= 0) {
    return res.status(400).json({ message: "amount must be a positive number" });
  }
  if (!reason || !reason.trim()) {
    return res.status(400).json({ message: "reason is required" });
  }

  try {
    const shift = await Shift.findById(id);
    if (!shift) return res.status(404).json({ message: "Shift not found" });
    if (!req.user.isAdmin && String(shift.openedBy) !== String(req.user._id)) {
      return res.status(403).json({ message: "This isn't your shift" });
    }
    if (shift.status !== "open") {
      return res.status(400).json({ message: "Cannot log petty cash against a closed shift" });
    }

    const entry = await PettyCash.create({ shift: id, amount, reason: reason.trim(), loggedBy });

    const io = req.app.get("io");
    io.emit("shift:pettyCashAdded", entry);

    res.status(201).json(entry);
  } catch (error) {
    console.error("Error adding petty cash entry:", error.message);
    res.status(500).json({ message: "Failed to add petty cash entry", error: error.message });
  }
};

// Shared calculation used by preview + real close. Now aggregates straight
// from each receipt's `payments[]` array (grouped by method) instead of
// only reading cashAmount/tillAmount — so it correctly reflects cash, till,
// M-Pesa prompt AND reward payments processed under this shift.
const computeShiftSummary = async (shiftId) => {
  const shift = await Shift.findById(shiftId).populate("openedBy", "fullName").populate("closedBy", "fullName");
  if (!shift) return null;

  const receipts = await Receipt.find({ shift: shiftId, status: { $in: ["paid", "partial"] } });

  const totals = { cash: 0, till: 0, prompt: 0, reward: 0 };
  receipts.forEach((r) => {
    r.payments.forEach((p) => {
      if (p.method === "cash") totals.cash += p.amount;
      else if (["mpesa_till", "manual_till", "mpesa_paybill", "mpesa_pochi"].includes(p.method)) totals.till += p.amount;
      else if (p.method === "mpesa_stk") totals.prompt += p.amount;
      else if (p.method === "reward") totals.reward += p.amount;
    });
  });

  const voidedReceipts = await Receipt.find({ shift: shiftId, status: "voided" });
  const voidedTotal = voidedReceipts.reduce((sum, r) => sum + r.subtotal, 0);

  const pettyEntries = await PettyCash.find({ shift: shiftId });
  const pettyCashOut = pettyEntries.reduce((sum, e) => sum + e.amount, 0);

  const shiftReceiptIds = await Receipt.find({ shift: shiftId }).distinct("_id");
  const pendingVoidRequests = await VoidRequest.countDocuments({
    status: "pending",
    receipt: { $in: shiftReceiptIds },
  });

  const expectedCash = shift.openingFloat + totals.cash - pettyCashOut;
  const grandTotal = totals.cash + totals.till + totals.prompt + totals.reward;
  const variance = shift.closingCashCount !== null ? shift.closingCashCount - expectedCash : null;

  return {
    shiftId: shift._id,
    status: shift.status,
    openedBy: shift.openedBy,
    openedAt: shift.createdAt,
    closedBy: shift.closedBy,
    closedAt: shift.closedAt,
    openingFloat: shift.openingFloat,
    cashSales: totals.cash,
    tillSales: totals.till,
    promptSales: totals.prompt,
    rewardSales: totals.reward,
    voidedTotal,
    pettyCashOut,
    expectedCash,
    grandTotal,
    tipsDeclared: shift.tipsDeclared || 0,
    closingCashCount: shift.closingCashCount,
    variance,
    pendingVoidRequests,
  };
};

// @desc    Preview a shift's totals without closing it (must be yours, unless admin)
// @route   GET /api/shifts/:id/summary
// @access  Protected
export const getShiftSummary = async (req, res) => {
  const { id } = req.params;
  try {
    const shift = await Shift.findById(id);
    if (!shift) return res.status(404).json({ message: "Shift not found" });
    if (!req.user.isAdmin && String(shift.openedBy) !== String(req.user._id)) {
      return res.status(403).json({ message: "This isn't your shift" });
    }
    const summary = await computeShiftSummary(id);
    res.json(summary);
  } catch (error) {
    console.error("Error computing shift summary:", error.message);
    res.status(500).json({ message: "Failed to compute shift summary", error: error.message });
  }
};

// @desc    Close a shift (must be yours, unless admin)
// @route   POST /api/shifts/:id/close
// @access  Protected
export const closeShift = async (req, res) => {
  const { id } = req.params;
  const { closingCashCount, tipsDeclared, notes } = req.body;
  const closedBy = req.user._id;

  if (closingCashCount === undefined || closingCashCount === null || isNaN(closingCashCount)) {
    return res.status(400).json({ message: "closingCashCount is required and must be a number" });
  }

  try {
    const shift = await Shift.findById(id);
    if (!shift) return res.status(404).json({ message: "Shift not found" });
    if (!req.user.isAdmin && String(shift.openedBy) !== String(req.user._id)) {
      return res.status(403).json({ message: "This isn't your shift" });
    }
    if (shift.status !== "open") {
      return res.status(400).json({ message: "Shift is already closed" });
    }

    shift.closingCashCount = closingCashCount;
    shift.tipsDeclared = tipsDeclared || 0;
    shift.notes = notes || null;
    shift.closedBy = closedBy;
    shift.closedAt = new Date();
    shift.status = "closed";
    await shift.save();

    const summary = await computeShiftSummary(id);

    const io = req.app.get("io");
    io.emit("shift:closed", summary);

    res.json(summary);
  } catch (error) {
    console.error("Error closing shift:", error.message);
    res.status(500).json({ message: "Failed to close shift", error: error.message });
  }
};

// @desc    Admin — shift history for one accountant, filterable by date
// @route   GET /api/shifts/history/:userId?from=&to=
// @access  Protected — admin
export const getShiftHistory = async (req, res) => {
  const { userId } = req.params;
  const { from, to } = req.query;
  try {
    const query = { openedBy: userId };
    if (from || to) {
      query.createdAt = {};
      if (from) query.createdAt.$gte = new Date(from);
      if (to) query.createdAt.$lte = new Date(to);
    }
    const shifts = await Shift.find(query).sort({ createdAt: -1 }).populate("closedBy", "fullName");
    res.json(shifts);
  } catch (error) {
    res.status(500).json({ message: "Failed to load shift history", error: error.message });
  }
};

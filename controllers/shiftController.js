// controllers/shiftController.js
import Shift from "../models/Shift.js";
import PettyCash from "../models/PettyCash.js";
import Receipt from "../models/Receipt.js";
import VoidRequest from "../models/VoidRequest.js";

// @desc    Open a new till shift
// @route   POST /api/shifts/open
// @access  Protected
export const openShift = async (req, res) => {
  const { openingFloat } = req.body;
  const openedBy = req.user._id;

  if (openingFloat === undefined || openingFloat === null || isNaN(openingFloat)) {
    return res.status(400).json({ message: "openingFloat is required and must be a number" });
  }

  try {
    const existing = await Shift.findOne({ status: "open" });
    if (existing) {
      return res.status(400).json({ message: "A shift is already open", shift: existing });
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

// @desc    Get the currently open shift, or null — shared till, not per-cashier
// @route   GET /api/shifts/current
// @access  Protected
export const getCurrentShift = async (req, res) => {
  try {
    const shift = await Shift.findOne({ status: "open" }).populate("openedBy", "fullName");
    res.json(shift);
  } catch (error) {
    console.error("Error fetching current shift:", error.message);
    res.status(500).json({ message: "Failed to fetch current shift", error: error.message });
  }
};

// @desc    Log a petty cash out-payment against an open shift
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
    if (shift.status !== "open") {
      return res.status(400).json({ message: "Cannot log petty cash against a closed shift" });
    }

    const entry = await PettyCash.create({
      shift: id,
      amount,
      reason: reason.trim(),
      loggedBy,
    });

    const io = req.app.get("io");
    io.emit("shift:pettyCashAdded", entry);

    res.status(201).json(entry);
  } catch (error) {
    console.error("Error adding petty cash entry:", error.message);
    res.status(500).json({ message: "Failed to add petty cash entry", error: error.message });
  }
};

// Shared calculation used by both the preview (GET summary) and the
// real close (POST close), so the two can never disagree.
//
// Cash/till are now attributed from the receipt's own cashAmount/tillAmount
// fields, which are populated correctly for cash-only, till-only, AND split
// "both" payments — so a split payment counts its cash portion toward
// expected cash-in-drawer and its till portion toward M-Pesa totals.
const computeShiftSummary = async (shiftId) => {
  const shift = await Shift.findById(shiftId);
  if (!shift) return null;

  const paidReceipts = await Receipt.find({ shift: shiftId, status: "paid" });

  const totals = { cash: 0, mpesa_till: 0, mpesa_paybill: 0, mpesa_pochi: 0 };
  paidReceipts.forEach((r) => {
    totals.cash += r.cashAmount || 0;
    totals.mpesa_till += r.tillAmount || 0;
    if (r.paymentMethod === "mpesa_paybill") totals.mpesa_paybill += r.amountPaid || 0;
    if (r.paymentMethod === "mpesa_pochi") totals.mpesa_pochi += r.amountPaid || 0;
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
  const grandTotal = totals.cash + totals.mpesa_till + totals.mpesa_paybill + totals.mpesa_pochi;

  const variance =
    shift.closingCashCount !== null ? shift.closingCashCount - expectedCash : null;

  return {
    shiftId: shift._id,
    status: shift.status,
    openedBy: shift.openedBy,
    openedAt: shift.createdAt,
    openingFloat: shift.openingFloat,
    cashSales: totals.cash,
    mpesaTill: totals.mpesa_till,
    mpesaPaybill: totals.mpesa_paybill,
    mpesaPochi: totals.mpesa_pochi,
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

// @desc    Preview a shift's totals without closing it
// @route   GET /api/shifts/:id/summary
// @access  Protected
export const getShiftSummary = async (req, res) => {
  const { id } = req.params;
  try {
    const summary = await computeShiftSummary(id);
    if (!summary) return res.status(404).json({ message: "Shift not found" });
    res.json(summary);
  } catch (error) {
    console.error("Error computing shift summary:", error.message);
    res.status(500).json({ message: "Failed to compute shift summary", error: error.message });
  }
};

// @desc    Close a shift, stamping the counted cash and recomputing the summary
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
    if (shift.status !== "open") {
      return res.status(400).json({ message: "Shift is already closed" });
    }

    // Stamp the counted values first, then recompute the summary
    // server-side using those exact stored numbers — never trust a
    // client-submitted variance.
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

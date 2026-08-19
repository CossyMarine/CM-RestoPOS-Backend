// controllers/accountantController.js
import User from "../models/User.js";
import Receipt from "../models/Receipt.js";
import Shift from "../models/Shift.js";
import { getKenyanDayBounds } from "../utils/dateHelpers.js";

const METHOD_BUCKET = (method) => {
  if (method === "cash") return "cash";
  if (["mpesa_till", "manual_till", "mpesa_paybill", "mpesa_pochi"].includes(method)) return "till";
  if (method === "mpesa_stk") return "prompt";
  if (method === "reward") return "reward";
  return "other";
};

// @desc    List all accountants with a quick glance at their last shift
// @route   GET /api/accountants
// @access  Protected — admin
export const listAccountants = async (req, res) => {
  try {
    const accountants = await User.find({ role: "accountant" }).select("-password");
    const results = await Promise.all(
      accountants.map(async (a) => {
        const lastShift = await Shift.findOne({ openedBy: a._id }).sort({ createdAt: -1 });
        return {
          ...a.toObject(),
          lastShift: lastShift
            ? { status: lastShift.status, openedAt: lastShift.createdAt, closedAt: lastShift.closedAt }
            : null,
        };
      })
    );
    res.json(results);
  } catch (error) {
    res.status(500).json({ message: "Failed to load accountants", error: error.message });
  }
};

// @desc    One accountant's processed-payment totals + shift log, filterable by date
// @route   GET /api/accountants/:id/stats?from=&to=
// @access  Protected — admin
export const getAccountantStats = async (req, res) => {
  const { id } = req.params;
  const { from, to } = req.query;

  try {
    const accountant = await User.findById(id).select("-password");
    if (!accountant || accountant.role !== "accountant") {
      return res.status(404).json({ message: "Accountant not found" });
    }

    // Both bounds are anchored to the Kenyan calendar day the picker value
    // falls on, and "to" is pushed to the end of that day so it's inclusive.
    const paymentMatch = { "payments.paidBy": accountant._id };
    if (from || to) {
      paymentMatch["payments.paidAt"] = {};
      if (from) paymentMatch["payments.paidAt"].$gte = getKenyanDayBounds(from).start;
      if (to) paymentMatch["payments.paidAt"].$lte = getKenyanDayBounds(to).end;
    }

    const grouped = await Receipt.aggregate([
      { $match: { "payments.paidBy": accountant._id } },
      { $unwind: "$payments" },
      { $match: paymentMatch },
      { $group: { _id: "$payments.method", total: { $sum: "$payments.amount" }, count: { $sum: 1 } } },
    ]);

    const totals = { cash: 0, till: 0, prompt: 0, reward: 0, other: 0 };
    let transactionCount = 0;
    grouped.forEach((g) => {
      transactionCount += g.count;
      totals[METHOD_BUCKET(g._id)] += g.total;
    });

    const shiftQuery = { openedBy: accountant._id };
    if (from || to) {
      shiftQuery.createdAt = {};
      if (from) shiftQuery.createdAt.$gte = getKenyanDayBounds(from).start;
      if (to) shiftQuery.createdAt.$lte = getKenyanDayBounds(to).end;
    }
    const shifts = await Shift.find(shiftQuery).sort({ createdAt: -1 }).populate("closedBy", "fullName");

    res.json({
      accountant,
      totals,
      grandTotal: totals.cash + totals.till + totals.prompt + totals.reward + totals.other,
      transactionCount,
      shifts,
    });
  } catch (error) {
    console.error("Error computing accountant stats:", error.message);
    res.status(500).json({ message: "Failed to load accountant stats", error: error.message });
  }
};
// @desc    Update an accountant's module permissions
// @route   PATCH /api/accountants/:id/permissions
// @access  Protected — admin
export const updateAccountantPermissions = async (req, res) => {
  const { id } = req.params;
  const { permissions } = req.body;

  if (!permissions || typeof permissions !== "object") {
    return res.status(400).json({ message: "permissions object is required" });
  }

const ALLOWED_KEYS = [
  "inventory", "manageMenu", "ordersReceipts", "voidRequests",
  "users", "settings", "waiterManagement", "kitchen", "payments",
  "paymentConfirmation", "applyDiscounts",
];

  try {
    const accountant = await User.findById(id);
    if (!accountant || accountant.role !== "accountant") {
      return res.status(404).json({ message: "Accountant not found" });
    }

    ALLOWED_KEYS.forEach((key) => {
      if (typeof permissions[key] === "boolean") accountant.permissions[key] = permissions[key];
    });
    await accountant.save();

    res.json({ message: "Permissions updated", permissions: accountant.permissions });
  } catch (error) {
    res.status(500).json({ message: "Failed to update permissions", error: error.message });
  }
};

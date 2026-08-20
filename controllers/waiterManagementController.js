import User from "../models/User.js";
import Receipt from "../models/Receipt.js";
import Order from "../models/Order.js";
import VoidRequest from "../models/VoidRequest.js";
import Shift from "../models/Shift.js";
import { getKenyanDateRanges } from "../utils/dateHelpers.js";

function getDateRanges() {
  return getKenyanDateRanges();
}

// @route GET /api/waiters/management?search=&status=all|active|inactive&sort=name|orders|sales|void
export const getWaiterManagementList = async (req, res) => {
  try {
    const { search = "", status = "all", sort = "name" } = req.query;

    const userFilter = { role: "waiter" };
    if (status === "active") userFilter.isActive = true;
    if (status === "inactive") userFilter.isActive = false;
    if (search) userFilter.fullName = { $regex: search, $options: "i" };

    const waiters = await User.find(userFilter).sort({ fullName: 1 });
    if (waiters.length === 0) return res.json([]);

    const names = waiters.map((w) => w.fullName);
    const { startOfToday, startOfWeek, startOfMonth, startOfYear } = getDateRanges();

    const orderStats = await Order.aggregate([
      { $match: { waiterName: { $in: names } } },
      { $group: {
          _id: "$waiterName",
          today: { $sum: { $cond: [{ $gte: ["$createdAt", startOfToday] }, 1, 0] } },
          week:  { $sum: { $cond: [{ $gte: ["$createdAt", startOfWeek] }, 1, 0] } },
          month: { $sum: { $cond: [{ $gte: ["$createdAt", startOfMonth] }, 1, 0] } },
          year:  { $sum: { $cond: [{ $gte: ["$createdAt", startOfYear] }, 1, 0] } },
          total: { $sum: 1 },
      }},
    ]);

    const billStats = await Receipt.aggregate([
      { $match: { waiterName: { $in: names }, status: "paid" } },
      { $group: { _id: "$waiterName", totalBalanceSold: { $sum: "$amountPaid" }, billsSold: { $sum: 1 } } },
    ]);

    const voidStats = await VoidRequest.aggregate([
      { $lookup: { from: "receipts", localField: "receipt", foreignField: "_id", as: "receiptDoc" } },
      { $unwind: "$receiptDoc" },
      { $match: { "receiptDoc.waiterName": { $in: names }, status: "approved" } },
      { $group: { _id: "$receiptDoc.waiterName", voidCount: { $sum: 1 }, voidAmount: { $sum: "$receiptDoc.totalDue" } } },
    ]);

    const orderMap = Object.fromEntries(orderStats.map((o) => [o._id, o]));
    const billMap = Object.fromEntries(billStats.map((b) => [b._id, b]));
    const voidMap = Object.fromEntries(voidStats.map((v) => [v._id, v]));

    let result = waiters.map((w) => ({
      id: w._id,
      fullName: w.fullName,
      email: w.email || null,
      phone: w.phone || null,
      isActive: w.isActive,
      waiterSince: w.waiterSince || w.createdAt,
      waiterSource: w.waiterSource || "direct",
      hiddenFromSelector: !!w.hiddenFromSelector,
      ordersToday: orderMap[w.fullName]?.today || 0,
      ordersWeek: orderMap[w.fullName]?.week || 0,
      ordersMonth: orderMap[w.fullName]?.month || 0,
      ordersYear: orderMap[w.fullName]?.year || 0,
      totalOrders: orderMap[w.fullName]?.total || 0,
      totalBalanceSold: billMap[w.fullName]?.totalBalanceSold || 0,
      billsSold: billMap[w.fullName]?.billsSold || 0,
      totalVoidCount: voidMap[w.fullName]?.voidCount || 0,
      totalVoidAmount: voidMap[w.fullName]?.voidAmount || 0,
    }));

    if (sort === "orders") result.sort((a, b) => b.totalOrders - a.totalOrders);
    if (sort === "sales") result.sort((a, b) => b.totalBalanceSold - a.totalBalanceSold);
    if (sort === "void") result.sort((a, b) => b.totalVoidCount - a.totalVoidCount);

    res.json(result);
  } catch (error) {
    console.error("GET WAITER MANAGEMENT LIST ERROR:", error);
    res.status(500).json({ message: "Failed to fetch waiter performance data" });
  }
};

// @route GET /api/waiters/management/:id
export const getWaiterDetail = async (req, res) => {
  try {
    const waiter = await User.findOne({ _id: req.params.id, role: "waiter" });
    if (!waiter) return res.status(404).json({ message: "Waiter not found" });

    const recentBills = await Receipt.find({ waiterName: waiter.fullName }).sort({ createdAt: -1 }).limit(50);
    const shiftHistory = await Shift.find({ openedBy: waiter._id }).sort({ createdAt: -1 }).limit(30);

    const orderCount = await Order.countDocuments({ waiterName: waiter.fullName });
    const totalSales = await Receipt.aggregate([
      { $match: { waiterName: waiter.fullName, status: "paid" } },
      { $group: { _id: null, sum: { $sum: "$amountPaid" } } },
    ]);
    const voidCount = await VoidRequest.countDocuments(); // filtered below via receipt lookup for accuracy
    const voidAgg = await VoidRequest.aggregate([
      { $lookup: { from: "receipts", localField: "receipt", foreignField: "_id", as: "r" } },
      { $unwind: "$r" },
      { $match: { "r.waiterName": waiter.fullName, status: "approved" } },
      { $count: "count" },
    ]);

    res.json({
      id: waiter._id, fullName: waiter.fullName, email: waiter.email, phone: waiter.phone,
      isActive: waiter.isActive, waiterSince: waiter.waiterSince || waiter.createdAt,
      waiterSource: waiter.waiterSource || "direct",
      totalOrders: orderCount,
      totalSales: totalSales[0]?.sum || 0,
      totalVoids: voidAgg[0]?.count || 0,
      recentBills, shiftHistory,
    });
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch waiter detail" });
  }
};

// @route PATCH /api/waiters/management/:id/drop  — soft removal, keeps history
export const dropWaiter = async (req, res) => {
  try {
    const waiter = await User.findOne({ _id: req.params.id, role: "waiter" });
    if (!waiter) return res.status(404).json({ message: "Waiter not found" });
    waiter.isActive = false;
    waiter.hiddenFromSelector = true;
    await waiter.save();
    res.json({ message: "Waiter dropped", waiter });
  } catch (error) {
    res.status(500).json({ message: "Failed to drop waiter" });
  }
};

// @route PATCH /api/waiters/management/:id/restore
export const restoreWaiter = async (req, res) => {
  try {
    const waiter = await User.findOne({ _id: req.params.id, role: "waiter" });
    if (!waiter) return res.status(404).json({ message: "Waiter not found" });
    waiter.isActive = true;
    waiter.hiddenFromSelector = false;
    await waiter.save();
    res.json({ message: "Waiter restored", waiter });
  } catch (error) {
    res.status(500).json({ message: "Failed to restore waiter" });
  }
};

// @route DELETE /api/waiters/management/:id — permanent
export const deleteWaiter = async (req, res) => {
  try {
    const waiter = await User.findOneAndDelete({ _id: req.params.id, role: "waiter" });
    if (!waiter) return res.status(404).json({ message: "Waiter not found" });
    res.json({ message: "Waiter removed permanently" });
  } catch (error) {
    res.status(500).json({ message: "Failed to delete waiter" });
  }
};

// @route GET /api/waiters/selector-list — ALL waiter accounts, for the visibility-management dropdown
export const getSelectorList = async (req, res) => {
  try {
    const waiters = await User.find({ role: "waiter" }).select("fullName isActive hiddenFromSelector").sort({ fullName: 1 });
    res.json(waiters.map((w) => ({ id: w._id, fullName: w.fullName, isActive: w.isActive, hidden: !!w.hiddenFromSelector })));
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch selector list" });
  }
};

// @route PATCH /api/waiters/:id/visibility  { hidden: true|false }
export const toggleWaiterVisibility = async (req, res) => {
  try {
    const { hidden } = req.body;
    const waiter = await User.findOne({ _id: req.params.id, role: "waiter" });
    if (!waiter) return res.status(404).json({ message: "Waiter not found" });
    waiter.hiddenFromSelector = !!hidden;
    await waiter.save();
    res.json({ message: "Visibility updated", waiter });
  } catch (error) {
    res.status(500).json({ message: "Failed to update visibility" });
  }
};

// @route GET /api/waiters/management/:id/selector-settings
// Returns this waiter's current selector config + the full list of other waiters to pick from
export const getWaiterSelectorSettings = async (req, res) => {
  try {
    const waiter = await User.findOne({ _id: req.params.id, role: "waiter" })
      .select("fullName selectorMode visibleWaiters");
    if (!waiter) return res.status(404).json({ message: "Waiter not found" });

    const allWaiters = await User.find({ role: "waiter", _id: { $ne: waiter._id } })
      .select("fullName isActive")
      .sort({ fullName: 1 });

    res.json({
      id: waiter._id,
      fullName: waiter.fullName,
      selectorMode: waiter.selectorMode || "all",
      visibleWaiters: (waiter.visibleWaiters || []).map(String),
      allWaiters: allWaiters.map((w) => ({ id: w._id, fullName: w.fullName, isActive: w.isActive })),
    });
  } catch (error) {
    console.error("GET WAITER SELECTOR SETTINGS ERROR:", error);
    res.status(500).json({ message: "Failed to fetch selector settings" });
  }
};

// @route PATCH /api/waiters/management/:id/selector-settings
// Body: { selectorMode: 'all' | 'custom', visibleWaiters: [waiterId, ...] }
export const updateWaiterSelectorSettings = async (req, res) => {
  try {
    const { selectorMode, visibleWaiters } = req.body;

    if (selectorMode && !["all", "custom"].includes(selectorMode)) {
      return res.status(400).json({ message: "Invalid selector mode" });
    }

    const waiter = await User.findOne({ _id: req.params.id, role: "waiter" });
    if (!waiter) return res.status(404).json({ message: "Waiter not found" });

    if (selectorMode) waiter.selectorMode = selectorMode;
    if (Array.isArray(visibleWaiters)) waiter.visibleWaiters = visibleWaiters;

    await waiter.save();
    res.json({ message: "Selector settings updated" });
  } catch (error) {
    console.error("UPDATE WAITER SELECTOR SETTINGS ERROR:", error);
    res.status(500).json({ message: "Failed to update selector settings" });
  }
};

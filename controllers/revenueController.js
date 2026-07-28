// controllers/revenueController.js
import Receipt from "../models/Receipt.js";
import { getKenyanDayBounds, getDateRangePreset } from "../utils/dateHelpers.js";

// @desc    Get total revenue and paid receipt count for today
// @route   GET /api/revenue/today
// @access  Public
export const getTodayRevenue = async (req, res) => {
  try {
    const { start: startOfDay, end: endOfDay } = getKenyanDayBounds();

    const result = await Receipt.aggregate([
      {
        $match: {
          status: "paid",
          paidAt: { $gte: startOfDay, $lte: endOfDay },
        },
      },
      {
        $group: {
          _id: null,
          totalRevenue: { $sum: "$subtotal" },
          paidReceiptsCount: { $sum: 1 },
        },
      },
    ]);

    const data = result[0] || { totalRevenue: 0, paidReceiptsCount: 0 };

    res.json({
      totalRevenue: data.totalRevenue,
      paidReceiptsCount: data.paidReceiptsCount,
    });
  } catch (error) {
    console.error("Error fetching today's revenue:", error.message);
    res.status(500).json({ message: "Failed to fetch revenue data", error: error.message });
  }
};

// @desc    Get all-time total revenue and total receipt count — Dashboard Overview cards
// @route   GET /api/revenue/summary
// @access  Protected — admin
export const getRevenueSummary = async (req, res) => {
  try {
    const result = await Receipt.aggregate([
      { $match: { status: "paid" } },
      {
        $group: {
          _id: null,
          totalRevenue: { $sum: "$subtotal" },
          totalPaidReceipts: { $sum: 1 },
        },
      },
    ]);

    const totalReceipts = await Receipt.countDocuments({});
    const data = result[0] || { totalRevenue: 0, totalPaidReceipts: 0 };

    res.json({
      totalRevenue: data.totalRevenue,
      totalPaidReceipts: data.totalPaidReceipts,
      totalReceipts,
    });
  } catch (error) {
    console.error("Error fetching revenue summary:", error.message);
    res.status(500).json({ message: "Failed to fetch revenue summary", error: error.message });
  }
};
// @desc    Revenue for each of the last 30 days — Analytics: 30-Day Revenue Trend
// @route   GET /api/revenue/trend
// @access  Protected — admin
export const getRevenueTrend = async (req, res) => {
  try {
    const DAYS = 30;
    const { start: todayStart } = getKenyanDayBounds();
    const rangeStart = new Date(todayStart);
    rangeStart.setDate(rangeStart.getDate() - (DAYS - 1));

    const result = await Receipt.aggregate([
      {
        $match: {
          status: "paid",
          paidAt: { $gte: rangeStart },
        },
      },
      {
        $group: {
          _id: {
            $dateToString: { format: "%Y-%m-%d", date: "$paidAt", timezone: "Africa/Nairobi" },
          },
          revenue: { $sum: "$subtotal" },
        },
      },
    ]);

    const byDate = new Map(result.map((r) => [r._id, r.revenue]));

    // Always return exactly 30 points, even for zero-revenue days, so the
    // chart's x-axis is never missing a day.
    const trend = [];
    for (let i = 0; i < DAYS; i++) {
      const d = new Date(rangeStart);
      d.setDate(d.getDate() + i);
      const key = d.toLocaleDateString("en-CA", { timeZone: "Africa/Nairobi" }); // YYYY-MM-DD
      trend.push({ date: key, revenue: byDate.get(key) || 0 });
    }

    res.json({ trend });
  } catch (error) {
    console.error("Error fetching revenue trend:", error.message);
    res.status(500).json({ message: "Failed to fetch revenue trend", error: error.message });
  }
};

// @desc    Revenue and order count grouped by day of week (Mon–Sun, current
//          week) — Analytics: Weekly Performance
// @route   GET /api/revenue/weekly
// @access  Protected — admin
export const getWeeklyPerformance = async (req, res) => {
  try {
    const { startDate, endDate } = getDateRangePreset("this_week"); // Mon..Sun

    const result = await Receipt.aggregate([
      {
        $match: {
          status: "paid",
          paidAt: { $gte: startDate, $lte: endDate },
        },
      },
      {
        $group: {
          _id: { $dayOfWeek: { date: "$paidAt", timezone: "Africa/Nairobi" } }, // Mongo: 1=Sun..7=Sat
          revenue: { $sum: "$subtotal" },
          orders: { $sum: 1 },
        },
      },
    ]);

    const byDow = new Map(result.map((r) => [r._id, r]));
    const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
    const MONGO_DOW = [2, 3, 4, 5, 6, 7, 1]; // maps Mon..Sun to Mongo's $dayOfWeek values

    const weekly = DAY_NAMES.map((day, i) => {
      const match = byDow.get(MONGO_DOW[i]);
      return { day, revenue: match?.revenue || 0, orders: match?.orders || 0 };
    });

    res.json({ weekly });
  } catch (error) {
    console.error("Error fetching weekly performance:", error.message);
    res.status(500).json({ message: "Failed to fetch weekly performance", error: error.message });
  }
};

// @desc    Top 3 best-selling meals by quantity sold — Analytics: Top 3
//          Performing Meals
// @route   GET /api/revenue/top-meals
// @access  Protected — admin
export const getTopMeals = async (req, res) => {
  try {
    const result = await Receipt.aggregate([
      { $match: { status: "paid" } },
      { $unwind: "$items" },
      {
        $group: {
          _id: "$items.mealName",
          orders: { $sum: "$items.quantity" },
        },
      },
      { $sort: { orders: -1 } },
      { $limit: 3 },
    ]);

    const totalOrders = result.reduce((sum, m) => sum + m.orders, 0);

    const topMeals = result.map((m, i) => ({
      rank: i + 1,
      name: m._id,
      orders: m.orders,
      percentage: totalOrders > 0 ? Number(((m.orders / totalOrders) * 100).toFixed(1)) : 0,
    }));

    res.json({ topMeals });
  } catch (error) {
    console.error("Error fetching top meals:", error.message);
    res.status(500).json({ message: "Failed to fetch top meals", error: error.message });
  }
};

// controllers/revenueController.js
import mongoose from "mongoose";
import Receipt from "../models/Receipt.js";
import { getKenyanDayBounds, getDateRangePreset } from "../utils/dateHelpers.js";
import { redisService } from "../routes/services/redis.service.js";

const REDIS_TTL_SECONDS = 30;

// @desc    Get total revenue and paid receipt count for today
// @route   GET /api/revenue/today?businessId=<id>
// @access  Public
//
// This route has NO auth middleware in front of it (see routes/revenueRoutes.js),
// so there is no req.businessId here. Whatever screen calls this (a public
// storefront/dashboard display?) needs to tell us which business via
// ?businessId=, same convention as the public menu/settings routes. Worth
// confirming with product/frontend what's actually meant to call this —
// "today's revenue" being public at all, even scoped, may be worth a second
// look.
export const getTodayRevenue = async (req, res) => {
  try {
    const { businessId } = req.query;
    if (!businessId) {
      return res.status(400).json({ message: "Missing businessId" });
    }

    const { start: startOfDay, end: endOfDay } = getKenyanDayBounds();

    const result = await Receipt.aggregate([
      {
        $match: {
          businessId: new mongoose.Types.ObjectId(businessId),
          status: "paid",
          paidAt: { $gte: startOfDay, $lte: endOfDay },
        },
      },
      {
        $group: {
          _id: null,
          totalRevenue: { $sum: "$amountPaid" },
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
    const { businessId } = req;
    const businessObjectId = new mongoose.Types.ObjectId(businessId);
    // Cache keys are now namespaced per business — they were previously
    // global ("dashboard:totalRevenue" / "dashboard:totalReceipts"), which
    // meant whichever business's dashboard loaded first would have its
    // totals cached and served to every other business for up to 30s.
    const totalRevenueCacheKey = `dashboard:totalRevenue:${businessId}`;
    const totalReceiptsCacheKey = `dashboard:totalReceipts:${businessId}`;

    // TEMPORARY REDIS PERFORMANCE TEST
    const revenueStart = Date.now();
    let totalRevenue = null;
    const cachedRevenue = await redisService.get(totalRevenueCacheKey);

    if (cachedRevenue !== null) {
      totalRevenue = cachedRevenue;
      console.log(`Dashboard KPI: Redis HIT totalRevenue — ${Date.now() - revenueStart}ms`);
    } else {
      const result = await Receipt.aggregate([
        { $match: { businessId: businessObjectId, status: "paid" } },
        {
          $group: {
            _id: null,
            totalRevenue: { $sum: "$amountPaid" },
          },
        },
      ]);

      const data = result[0] || { totalRevenue: 0 };
      totalRevenue = data.totalRevenue;
      await redisService.set(totalRevenueCacheKey, totalRevenue, REDIS_TTL_SECONDS);
      console.log(`Dashboard KPI: Redis MISS totalRevenue — MongoDB — ${Date.now() - revenueStart}ms`);
    }

    const receiptsStart = Date.now();
    let totalReceipts = null;
    const cachedReceipts = await redisService.get(totalReceiptsCacheKey);

    if (cachedReceipts !== null) {
      totalReceipts = cachedReceipts;
      console.log(`Dashboard KPI: Redis HIT totalReceipts — ${Date.now() - receiptsStart}ms`);
    } else {
      totalReceipts = await Receipt.countDocuments({ businessId });
      await redisService.set(totalReceiptsCacheKey, totalReceipts, REDIS_TTL_SECONDS);
      console.log(`Dashboard KPI: Redis MISS totalReceipts — MongoDB — ${Date.now() - receiptsStart}ms`);
    }

    const result = await Receipt.aggregate([
      { $match: { businessId: businessObjectId, status: "paid" } },
      {
        $group: {
          _id: null,
          totalPaidReceipts: { $sum: 1 },
        },
      },
    ]);

    const data = result[0] || { totalPaidReceipts: 0 };

    res.json({
      totalRevenue,
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
    const { businessId } = req;
    const DAYS = 30;
    const { start: todayStart } = getKenyanDayBounds();
    const rangeStart = new Date(todayStart);
    rangeStart.setDate(rangeStart.getDate() - (DAYS - 1));

    const result = await Receipt.aggregate([
      {
        $match: {
          businessId: new mongoose.Types.ObjectId(businessId),
          status: "paid",
          paidAt: { $gte: rangeStart },
        },
      },
      {
        $group: {
          _id: {
            $dateToString: { format: "%Y-%m-%d", date: "$paidAt", timezone: "Africa/Nairobi" },
          },
          revenue: { $sum: "$amountPaid" },
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
    const { businessId } = req;
    const { startDate, endDate } = getDateRangePreset("this_week"); // Mon..Sun

    const result = await Receipt.aggregate([
      {
        $match: {
          businessId: new mongoose.Types.ObjectId(businessId),
          status: "paid",
          paidAt: { $gte: startDate, $lte: endDate },
        },
      },
      {
        $group: {
          _id: { $dayOfWeek: { date: "$paidAt", timezone: "Africa/Nairobi" } }, // Mongo: 1=Sun..7=Sat
          revenue: { $sum: "$amountPaid" },
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
      { $match: { businessId: new mongoose.Types.ObjectId(req.businessId), status: "paid" } },
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
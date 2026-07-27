// controllers/revenueController.js
import Receipt from "../models/Receipt.js";
import { getKenyanDayBounds } from "../utils/dateHelpers.js";

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

// controllers/reportsController.js
import Receipt from "../models/Receipt.js";
import { getKenyanDayBounds } from "../utils/dateHelpers.js";

// Groups paid receipts by day (or by month) within a date range, and sums
// subtotal / discount / tax / revenue per group, plus grand totals across
// the whole range. This one function is what Daily, Monthly, and Tax
// reports are all built from — they're the same underlying breakdown at
// different date ranges and with different columns surfaced on the
// frontend, not three separate calculations.
const buildSalesReport = async ({ startDate, endDate, groupBy }) => {
  const dateFormat = groupBy === "month" ? "%Y-%m" : "%Y-%m-%d";

  const rows = await Receipt.aggregate([
    { $match: { status: "paid", paidAt: { $gte: startDate, $lte: endDate } } },
    {
      $group: {
        _id: { $dateToString: { format: dateFormat, date: "$paidAt", timezone: "Africa/Nairobi" } },
        subtotal: { $sum: "$subtotal" },
        discount: { $sum: "$discount.amount" },
        tax: { $sum: "$tax.amount" },
        revenue: { $sum: "$amountPaid" },
        receiptCount: { $sum: 1 },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  const rowsFormatted = rows.map((r) => ({
    period: r._id,
    subtotal: Number((r.subtotal || 0).toFixed(2)),
    discount: Number((r.discount || 0).toFixed(2)),
    tax: Number((r.tax || 0).toFixed(2)),
    revenue: Number((r.revenue || 0).toFixed(2)),
    receiptCount: r.receiptCount,
  }));

  const totals = rowsFormatted.reduce(
    (acc, r) => ({
      subtotal: acc.subtotal + r.subtotal,
      discount: acc.discount + r.discount,
      tax: acc.tax + r.tax,
      revenue: acc.revenue + r.revenue,
      receiptCount: acc.receiptCount + r.receiptCount,
    }),
    { subtotal: 0, discount: 0, tax: 0, revenue: 0, receiptCount: 0 }
  );
  ["subtotal", "discount", "tax", "revenue"].forEach((k) => {
    totals[k] = Number(totals[k].toFixed(2));
  });

  return { rows: rowsFormatted, totals };
};

// @desc    Sales report for a single day (defaults to today)
// @route   GET /api/reports/daily?date=YYYY-MM-DD
// @access  Protected — admin
export const getDailyReport = async (req, res) => {
  try {
    const { start, end } = getKenyanDayBounds(req.query.date || undefined);
    const report = await buildSalesReport({ startDate: start, endDate: end, groupBy: "day" });
    res.json(report);
  } catch (error) {
    console.error("Error building daily report:", error.message);
    res.status(500).json({ message: "Failed to build daily report" });
  }
};

// @desc    Sales report broken down day-by-day for a given month
// @route   GET /api/reports/monthly?month=1-12&year=YYYY
// @access  Protected — admin
export const getMonthlyReport = async (req, res) => {
  try {
    const now = new Date();
    const year = parseInt(req.query.year) || now.getFullYear();
    const month = req.query.month ? parseInt(req.query.month) - 1 : now.getMonth();
    const startDate = new Date(year, month, 1, 0, 0, 0);
    const endDate = new Date(year, month + 1, 0, 23, 59, 59, 999);
    const report = await buildSalesReport({ startDate, endDate, groupBy: "day" });
    res.json(report);
  } catch (error) {
    console.error("Error building monthly report:", error.message);
    res.status(500).json({ message: "Failed to build monthly report" });
  }
};

// @desc    VAT report — tax collected, day by day, over a date range.
//          Defaults to the current month if no range is given.
// @route   GET /api/reports/tax?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
// @access  Protected — admin
export const getTaxReport = async (req, res) => {
  try {
    let startDate, endDate;
    if (req.query.startDate && req.query.endDate) {
      startDate = getKenyanDayBounds(req.query.startDate).start;
      endDate = getKenyanDayBounds(req.query.endDate).end;
    } else {
      const now = new Date();
      startDate = new Date(now.getFullYear(), now.getMonth(), 1);
      endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
    }
    const report = await buildSalesReport({ startDate, endDate, groupBy: "day" });
    res.json(report);
  } catch (error) {
    console.error("Error building tax report:", error.message);
    res.status(500).json({ message: "Failed to build tax report" });
  }
};
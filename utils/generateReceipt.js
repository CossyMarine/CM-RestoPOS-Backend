// utils/generateReceipt.js
import Counter from "../models/Counter.js";
import Receipt from "../models/Receipt.js";
import Shift from "../models/Shift.js";
import User from "../models/User.js";
import AdminSettings from "../models/AdminSettings.js";
import { computeBillTotals } from "./billing.js";
export const generateReceiptForOrder = async (order, { customer } = {}) => {
  const counter = await Counter.findOneAndUpdate(
    { name: "bill" },
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );

  const billId = `#B${counter.seq.toString().padStart(4, "0")}`;

  // Resolve the shift to attach to. If the order carries a waiterName,
  // find THAT waiter's own open shift (not just "any open shift") —
  // needed because multiple waiters can share one station login.
  let openShift = null;
  if (order.waiterName) {
    const waiterUser = await User.findOne({ fullName: order.waiterName, role: "waiter" }).select("_id");
    if (waiterUser) {
      openShift = await Shift.findOne({ openedBy: waiterUser._id, status: "open" });
    }
  }
  // Fall back to the old behavior for non-waiter flows (accountant till, etc.)
  if (!openShift) {
    openShift = await Shift.findOne({ status: "open" });
  }
const settings = await AdminSettings.getSettings();
const { taxAmount, totalDue } = computeBillTotals({
  subtotal: order.subtotal,
  discount: null,
  taxSettings: settings.tax,
});
 const receipt = await Receipt.create({
  billId,
  order: order._id,
  shift: openShift ? openShift._id : null,
  tableNumber: order.tableNumber,
  waiterName: order.waiterName,
  source: order.source || "staff",
  items: order.items,
  subtotal: order.subtotal,
  customer: customer || order.customer || null,
  tax: {
    ratePercent: settings.tax?.enabled ? settings.tax.ratePercent : 0,
    inclusive: settings.tax?.inclusive ?? true,
    amount: taxAmount,
  },
  totalDue,
});

  return receipt;
};

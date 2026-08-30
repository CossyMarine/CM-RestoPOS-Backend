// utils/generateReceipt.js
import Counter from "../models/Counter.js";
import Receipt from "../models/Receipt.js";
import Shift from "../models/Shift.js";
import User from "../models/User.js";
import AdminSettings from "../models/AdminSettings.js";
import { computeBillTotals } from "./billing.js";

// businessId is read off the order itself (Order already carries it) rather
// than requiring every call site to thread an extra argument through.
export const generateReceiptForOrder = async (order, { customer } = {}) => {
  const businessId = order.businessId;

  // Filter fields on an upsert (name, businessId) get written onto the newly
  // created document alongside the $inc result, so per-business numbering
  // starts at #B0001 for each new business without any extra seeding step.
  const counter = await Counter.findOneAndUpdate(
    { name: "bill", businessId },
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );

  const billId = `#B${counter.seq.toString().padStart(4, "0")}`;

  // Resolve the shift to attach to. If the order carries a waiterName,
  // find THAT waiter's own open shift (not just "any open shift") —
  // needed because multiple waiters can share one station login.
  let openShift = null;
  if (order.waiterName) {
    const waiterUser = await User.findOne({ fullName: order.waiterName, role: "waiter", businessId }).select("_id");
    if (waiterUser) {
      openShift = await Shift.findOne({ openedBy: waiterUser._id, status: "open", businessId });
    }
  }
  // Fall back to the old behavior for non-waiter flows (accountant till, etc.)
  if (!openShift) {
    openShift = await Shift.findOne({ status: "open", businessId });
  }

  const settings = await AdminSettings.getSettings(businessId);
  const { taxAmount, totalDue } = computeBillTotals({
    subtotal: order.subtotal,
    discount: null,
    taxSettings: settings.tax,
  });

  const receipt = await Receipt.create({
    businessId,
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
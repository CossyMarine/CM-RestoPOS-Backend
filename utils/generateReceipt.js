import Counter from "../models/Counter.js";
import Receipt from "../models/Receipt.js";
import Shift from "../models/Shift.js";
import User from "../models/User.js";
import AdminSettings from "../models/AdminSettings.js";
import { computeBillTotals } from "./billing.js";

export const generateReceiptForOrder = async (
  order,
  { customer, session = null } = {}
) => {
  const businessId = order.businessId;

  const counter = await Counter.findOneAndUpdate(
    { name: "bill", businessId },
    { $inc: { seq: 1 } },
    {
      new: true,
      upsert: true,
      session,
    }
  );

  const billId = `#B${counter.seq.toString().padStart(4, "0")}`;

  let openShift = null;

  if (order.waiterName) {
    const waiterUser = await User.findOne({
      fullName: order.waiterName,
      role: "waiter",
      businessId,
    })
      .select("_id")
      .session(session);

    if (waiterUser) {
      openShift = await Shift.findOne({
        openedBy: waiterUser._id,
        status: "open",
        businessId,
      }).session(session);
    }
  }

  if (!openShift) {
    openShift = await Shift.findOne({
      status: "open",
      businessId,
    }).session(session);
  }

  const settings = await AdminSettings.getSettings(businessId);

  const { taxAmount, totalDue } = computeBillTotals({
    subtotal: order.subtotal,
    discount: null,
    taxSettings: settings.tax,
  });

  const receipt = new Receipt({
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

  await receipt.save({ session });

  return receipt;
};
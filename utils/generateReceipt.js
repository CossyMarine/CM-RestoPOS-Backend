// utils/generateReceipt.js
import Counter from "../models/Counter.js";
import Receipt from "../models/Receipt.js";
import Shift from "../models/Shift.js";

// Shared by staff orders and customer orders so bill numbering and
// shift-linking can never drift apart between the two flows.
export const generateReceiptForOrder = async (order, { customer } = {}) => {
  const counter = await Counter.findOneAndUpdate(
    { name: "bill" },
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  const billId = `#B${counter.seq.toString().padStart(4, "0")}`;

  // Attach whichever shift is currently open, so shift summaries
  // (cash totals, mpesa totals) actually see this sale.
  const openShift = await Shift.findOne({ status: "open" });

  const receipt = await Receipt.create({
    billId,
    order: order._id,
    shift: openShift ? openShift._id : null,
    tableNumber: order.tableNumber,
    waiterName: order.waiterName,
    items: order.items,
    subtotal: order.subtotal,
    customer: customer || order.customer || null,
  });

  return receipt;
};

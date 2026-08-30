// controllers/receipt/receiptManagement.js
import Receipt from "../../models/Receipt.js";
import Order from "../../models/Order.js";
import AdminSettings from "../../models/AdminSettings.js";
import { computeBillTotals } from "../../utils/billing.js";

// @desc    Add items to an unpaid bill (customer wants to order more before paying)
// @route   PATCH /api/receipts/:id/items
// @access  Protected — waiter, manager, admin, cashier
export const addItemsToReceipt = async (req, res) => {
  const { businessId } = req;
  const { id } = req.params;
  const { items } = req.body;

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ message: "At least one item is required" });
  }

  try {
    const receipt = await Receipt.findOne({ _id: id, businessId });
    if (!receipt) return res.status(404).json({ message: "Receipt not found" });
    if (receipt.status !== "unpaid") {
      return res.status(400).json({ message: "Only unpaid bills can be added to" });
    }

    const now = new Date();

    // Always appended as their own line items — never merged into an existing
    // line — so each addition stays a distinct, clearly-flagged kitchen ticket
    // regardless of whether an earlier line of the same dish is already ready.
    const addedItems = items.map((incoming) => ({
      menuItemId: incoming.menuItemId || incoming._id || null,
      mealName: incoming.mealName,
      imageUrl: incoming.imageUrl || null,
      quantity: incoming.quantity,
      unitPrice: incoming.unitPrice,
      lineTotal: incoming.quantity * incoming.unitPrice,
      ready: false,
      addedAt: now,
    }));

    const merged = [...receipt.items, ...addedItems];
    const subtotal = merged.reduce((sum, i) => sum + i.lineTotal, 0);

    const settings = await AdminSettings.getSettings(businessId);
    const { discountAmount, taxAmount, totalDue } = computeBillTotals({
      subtotal,
      discount: receipt.discount?.kind ? receipt.discount : null,
      taxSettings: settings.tax,
    });

    receipt.items = merged;
    receipt.subtotal = subtotal;
    receipt.discount.amount = discountAmount; // re-clamped/recalculated against the new subtotal
    receipt.tax = {
      ratePercent: settings.tax?.enabled ? settings.tax.ratePercent : 0,
      inclusive: settings.tax?.inclusive ?? true,
      amount: taxAmount,
    };
    receipt.totalDue = totalDue;
    await receipt.save();

    const existingOrder = await Order.findOne({ _id: receipt.order, businessId });

    // Was this ticket already served/cancelled and cleared off the kitchen
    // screen? If so, silently merging new items into that same order would
    // either resurrect a card kitchen already dismissed, or bury the new
    // items among ones already prepared. Instead we reopen the order (so
    // billing/history stays on one continuous record) but tell the kitchen
    // to treat it as a brand-new ticket.
    const reopened = !!existingOrder && ["completed", "cancelled"].includes(existingOrder.status);

    const orderUpdate = { items: merged, subtotal };
    if (reopened) {
      orderUpdate.status = "pending";
      orderUpdate.servedAt = null;
      orderUpdate.cancelledAt = null;
    }

    const order = await Order.findOneAndUpdate({ _id: receipt.order, businessId }, orderUpdate, { new: true });

    const io = req.app.get("io");
    io.emit("receipt:updated", receipt);
    if (order) {
      io.emit("order:updated", order);
      // Kitchen-facing signal. `reopened` tells the kitchen screen whether
      // this is a fresh ticket (order was already served/cleared) or an
      // addition to a still-active one.
      io.emit("order:itemsAdded", { order, receipt, addedItems, reopened });
    }

    res.json(receipt);
  } catch (error) {
    console.error("Error adding items to receipt:", error.message);
    res.status(500).json({ message: "Failed to add items", error: error.message });
  }
};

// @desc    Apply (or clear) a discount on a fully-unpaid bill.
// @route   PATCH /api/receipts/:id/discount
// @access  Protected — admin OR accountant with applyDiscounts permission
export const applyDiscount = async (req, res) => {
  const { businessId } = req;
  const { id } = req.params;
  const { kind, value, reason } = req.body; // kind: "percent" | "fixed" | null (null clears it)

  if (kind && !["percent", "fixed"].includes(kind)) {
    return res.status(400).json({ message: "Discount kind must be 'percent' or 'fixed'" });
  }
  if (kind && (isNaN(value) || value <= 0)) {
    return res.status(400).json({ message: "Discount value must be a positive number" });
  }
  if (kind === "percent" && value > 100) {
    return res.status(400).json({ message: "Percentage discount cannot exceed 100" });
  }

  try {
    const receipt = await Receipt.findOne({ _id: id, businessId });
    if (!receipt) return res.status(404).json({ message: "Receipt not found" });
    if (receipt.status !== "unpaid") {
      return res.status(400).json({ message: "Only unpaid bills can be discounted" });
    }

    const settings = await AdminSettings.getSettings(businessId);
    const discountInput = kind ? { kind, value: Number(value) } : null;
    const { discountAmount, taxAmount, totalDue } = computeBillTotals({
      subtotal: receipt.subtotal,
      discount: discountInput,
      taxSettings: settings.tax,
    });

    receipt.discount = kind
      ? { kind, value: Number(value), amount: discountAmount, reason: reason || null, appliedBy: req.user?._id || null }
      : { kind: null, value: 0, amount: 0, reason: null, appliedBy: null };

    receipt.tax = {
      ratePercent: settings.tax?.enabled ? settings.tax.ratePercent : 0,
      inclusive: settings.tax?.inclusive ?? true,
      amount: taxAmount,
    };
    receipt.totalDue = totalDue;

    await receipt.save();

    const io = req.app.get("io");
    io.emit("receipt:updated", receipt);

    res.json({ message: kind ? "Discount applied" : "Discount cleared", receipt });
  } catch (error) {
    console.error("Error applying discount:", error.message);
    res.status(500).json({ message: "Failed to apply discount", error: error.message });
  }
};

export const markReceiptPrinted = async (req, res) => {
  try {
    const { businessId } = req;
    const receipt = await Receipt.findOneAndUpdate(
      { _id: req.params.id, businessId },
      { $inc: { printCount: 1 }, $set: { printedAt: new Date() } },
      { new: true }
    );
    if (!receipt) return res.status(404).json({ message: "Receipt not found" });
    res.json(receipt);
  } catch (error) {
    console.error("Error marking receipt printed:", error.message);
    res.status(500).json({ message: "Failed to update print status" });
  }
};
// controllers/receipt/receiptManagement.js
import Receipt from "../../models/Receipt.js";
import Order from "../../models/Order.js";

// @desc    Add items to an unpaid bill (customer wants to order more before paying)
// @route   PATCH /api/receipts/:id/items
// @access  Protected — waiter, manager, admin, cashier
export const addItemsToReceipt = async (req, res) => {
  const { id } = req.params;
  const { items } = req.body;

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ message: "At least one item is required" });
  }

  try {
    const receipt = await Receipt.findById(id);
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

    receipt.items = merged;
    receipt.subtotal = subtotal;
    await receipt.save();

    const order = await Order.findByIdAndUpdate(
      receipt.order,
      { items: merged, subtotal },
      { new: true }
    );

    const io = req.app.get("io");
    io.emit("receipt:updated", receipt);
    if (order) {
      io.emit("order:updated", order);
      // Dedicated event: kitchen treats this as a fresh ticket for the
      // *added* items only — rings the alarm and flags the order as new
      // again, without re-announcing items already in prep/ready.
      io.emit("order:itemsAdded", { order, receipt, addedItems });
    }

    res.json(receipt);
  } catch (error) {
    console.error("Error adding items to receipt:", error.message);
    res.status(500).json({ message: "Failed to add items", error: error.message });
  }
};

    

// @desc    Record that a receipt was (re)printed
// @route   PATCH /api/receipts/:id/print
// @access  Protected
export const markReceiptPrinted = async (req, res) => {
  try {
    const receipt = await Receipt.findByIdAndUpdate(
      req.params.id,
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

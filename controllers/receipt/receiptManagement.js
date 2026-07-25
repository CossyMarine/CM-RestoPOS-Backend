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

    const merged = [...receipt.items];
    items.forEach((incoming) => {
      const lineTotal = incoming.quantity * incoming.unitPrice;
      const existing = merged.find(
        (i) => i.mealName === incoming.mealName && i.unitPrice === incoming.unitPrice
      );
      if (existing) {
        existing.quantity += incoming.quantity;
        existing.lineTotal += lineTotal;
      } else {
        merged.push({
          mealName: incoming.mealName,
          quantity: incoming.quantity,
          unitPrice: incoming.unitPrice,
          lineTotal,
        });
      }
    });

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
    if (order) io.emit("order:updated", order);

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

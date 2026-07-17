// controllers/receiptController.js
import Receipt from "../models/Receipt.js";
import Order from "../models/Order.js";

// @desc    Mark a receipt as paid
// @route   PATCH /api/receipts/:id/pay
// @access  Protected — admin
export const payReceipt = async (req, res) => {
  const { id } = req.params;
  const { paymentMethod, amountPaid } = req.body;

  try {
    const receipt = await Receipt.findById(id);

    if (!receipt) {
      return res.status(404).json({ message: "Receipt not found" });
    }
    if (receipt.status !== "unpaid") {
      return res.status(400).json({ message: "Receipt is already paid or voided" });
    }

    const changeGiven = amountPaid - receipt.subtotal;

    receipt.status = "paid";
    receipt.paymentMethod = paymentMethod;
    receipt.amountPaid = amountPaid;
    receipt.changeGiven = changeGiven;
    receipt.paidAt = new Date();
    await receipt.save();

    await Order.findByIdAndUpdate(receipt.order, { status: "completed" });

    const io = req.app.get("io");
    io.emit("receipt:paid", receipt);

    res.json({ message: "Payment successful", receipt });
  } catch (error) {
    console.error("Error processing payment:", error.message);
    res.status(500).json({ message: "Failed to process payment", error: error.message });
  }
};

// @desc    Get all unpaid receipts
// @route   GET /api/receipts
// @access  Protected — admin
export const getReceipts = async (req, res) => {
  try {
    const receipts = await Receipt.find({ status: "unpaid" }).sort({ createdAt: -1 });
    res.json(receipts);
  } catch (error) {
    console.error("Error fetching receipts:", error.message);
    res.status(500).json({ message: "Failed to fetch receipts" });
  }
};

// @desc    Get paid receipts (most recent first) — accountant view
// @route   GET /api/receipts/paid
// @access  Protected — admin, accountant
export const getPaidReceipts = async (req, res) => {
  try {
    const receipts = await Receipt.find({ status: "paid" }).sort({ paidAt: -1 }).limit(200);
    res.json(receipts);
  } catch (error) {
    console.error("Error fetching paid receipts:", error.message);
    res.status(500).json({ message: "Failed to fetch paid receipts" });
  }
};

// @desc    Get unpaid receipts for a specific waiter
// @route   GET /api/receipts/waiter/:name
// @access  Protected
export const getReceiptsByWaiter = async (req, res) => {
  try {
    const { name } = req.params;
    const receipts = await Receipt.find({ waiterName: name, status: "unpaid" }).sort({
      createdAt: -1,
    });
    res.json(receipts);
  } catch (error) {
    console.error("Error fetching receipts by waiter:", error.message);
    res.status(500).json({ message: "Failed to fetch receipts" });
  }
};

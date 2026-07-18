// controllers/voidRequestController.js
import Receipt from "../models/Receipt.js";
import VoidRequest from "../models/VoidRequest.js";

// @desc    Get all pending void requests, with receipt + requester populated
// @route   GET /api/void-requests
// @access  Protected — admin
export const getVoidRequests = async (req, res) => {
  try {
    const voidRequests = await VoidRequest.find({ status: "pending" })
      .populate("receipt")
      .populate("requestedBy", "fullName")
      .sort({ createdAt: -1 });

    res.json(voidRequests);
  } catch (error) {
    console.error("Error fetching void requests:", error.message);
    res.status(500).json({ message: "Failed to fetch void requests", error: error.message });
  }
};

// @desc    Request a receipt be voided
// @route   POST /api/void-requests
// @access  Protected — cashier, manager, admin
export const createVoidRequest = async (req, res) => {
  try {
    const { receiptId, reason } = req.body;
    const requestedBy = req.user._id;

    const receipt = await Receipt.findById(receiptId);
    if (!receipt) {
      return res.status(404).json({ message: "Receipt not found" });
    }
    if (receipt.status === "voided") {
      return res.status(400).json({ message: "Receipt is already voided" });
    }

    const voidRequest = await VoidRequest.create({
      receipt: receiptId,
      requestedBy,
      reason,
    });

    const io = req.app.get("io");
    io.emit("voidRequest:created", voidRequest);

    res.status(201).json({ message: "Void request submitted", voidRequest });
  } catch (error) {
    console.error("Error creating void request:", error.message);
    res.status(500).json({ message: "Failed to create void request", error: error.message });
  }
};

// @desc    Approve a void request — voids the underlying receipt
// @route   PATCH /api/void-requests/:id/approve
// @access  Protected — manager, admin
export const approveVoidRequest = async (req, res) => {
  const { id } = req.params;
  const reviewedBy = req.user._id;

  try {
    const voidRequest = await VoidRequest.findByIdAndUpdate(
      id,
      { status: "approved", reviewedBy, reviewedAt: new Date() },
      { new: true }
    );

    if (!voidRequest) {
      return res.status(404).json({ message: "Void request not found" });
    }

    await Receipt.findByIdAndUpdate(voidRequest.receipt, { status: "voided" });

    const io = req.app.get("io");
    io.emit("voidRequest:approved", voidRequest);

    res.json({ message: "Void request approved", voidRequest });
  } catch (error) {
    console.error("Error approving void request:", error.message);
    res.status(500).json({ message: "Failed to approve void request", error: error.message });
  }
};

// @desc    Reject a void request — receipt stays as-is
// @route   PATCH /api/void-requests/:id/reject
// @access  Protected — manager, admin
export const rejectVoidRequest = async (req, res) => {
  const { id } = req.params;
  const reviewedBy = req.user._id;

  try {
    const voidRequest = await VoidRequest.findByIdAndUpdate(
      id,
      { status: "rejected", reviewedBy, reviewedAt: new Date() },
      { new: true }
    );

    if (!voidRequest) {
      return res.status(404).json({ message: "Void request not found" });
    }

    const io = req.app.get("io");
    io.emit("voidRequest:rejected", voidRequest);

    res.json({ message: "Void request rejected", voidRequest });
  } catch (error) {
    console.error("Error rejecting void request:", error.message);
    res.status(500).json({ message: "Failed to reject void request", error: error.message });
  }
};

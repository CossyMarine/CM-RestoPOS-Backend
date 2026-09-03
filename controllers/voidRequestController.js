// controllers/voidRequestController.js
import Receipt from "../models/Receipt.js";
import VoidRequest from "../models/VoidRequest.js";

// @desc    Get all pending void requests, with receipt + requester populated
// @route   GET /api/void-requests
// @access  Protected — admin
export const getVoidRequests = async (req, res) => {
  try {
    const voidRequests = await VoidRequest.find({ businessId: req.businessId, status: "pending" })
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
    const { businessId } = req;
    const { receiptId, reason } = req.body;
    const requestedBy = req.user._id;

    const receipt = await Receipt.findOne({ _id: receiptId, businessId });
    if (!receipt) {
      return res.status(404).json({ message: "Receipt not found" });
    }
    if (receipt.status === "voided") {
      return res.status(400).json({ message: "Receipt is already voided" });
    }

    const voidRequest = await VoidRequest.create({
      businessId,
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
  const { businessId } = req;

  try {
    const voidRequest = await VoidRequest.findOneAndUpdate(
      { _id: id, businessId },
      { status: "approved", reviewedBy, reviewedAt: new Date() },
      { new: true }
    );

    if (!voidRequest) {
      return res.status(404).json({ message: "Void request not found" });
    }

    const voidedReceipt = await Receipt.findOneAndUpdate(
      { _id: voidRequest.receipt, businessId },
      { status: "voided" }
    );
    if (!voidedReceipt) {
      console.warn(
        `approveVoidRequest: voidRequest ${voidRequest._id} references receipt ${voidRequest.receipt}, which was not found under businessId ${businessId} — possible cross-tenant data issue`
      );
    }

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
  const { businessId } = req;

  try {
    const voidRequest = await VoidRequest.findOneAndUpdate(
      { _id: id, businessId },
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
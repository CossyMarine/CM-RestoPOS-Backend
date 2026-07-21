// controllers/walletController.js
import Receipt from "../models/Receipt.js";
import User from "../models/User.js";
import MenuItem from "../models/MenuItem.js";
import AdminSettings from "../models/AdminSettings.js";
import { stkPush } from "../utils/mpesa.js";
import { applyPaymentToReceipt, applyRewardRedemption } from "../utils/walletPayments.js";

const attachMenuImages = async (items) => {
  const names = items.map((i) => i.mealName);
  const menuItems = await MenuItem.find({ name: { $in: names } }).select("name imageUrl");
  const imageByName = Object.fromEntries(menuItems.map((m) => [m.name.toLowerCase(), m.imageUrl]));
  return items.map((i) => ({
    mealName: i.mealName,
    quantity: i.quantity,
    unitPrice: i.unitPrice,
    lineTotal: i.lineTotal,
    imageUrl: imageByName[i.mealName?.toLowerCase()] || null,
  }));
};

const findCustomerByIdentifier = (identifier) =>
  User.findOne({
    $or: [{ email: identifier.toLowerCase().trim() }, { phone: identifier.trim() }],
    role: "customer",
  });

// @desc    Logged-in customer's wallet — points balance + unpaid/partial bills
// @route   GET /api/wallet/me
// @access  Protected
export const getMyWallet = async (req, res) => {
  try {
    const settings = await AdminSettings.getSettings();
    const bills = await Receipt.find({
      customer: req.user._id,
      status: { $in: ["unpaid", "partial"] },
    }).sort({ createdAt: -1 });

    const points = req.user.walletPoints || 0;

    res.json({
      points,
      pointValueKes: settings.reward.pointValueKes,
      targetPoints: settings.reward.targetPoints,
      redeemableKes: Number((points * settings.reward.pointValueKes).toFixed(2)),
      canRedeem: settings.reward.enabled && points >= (settings.reward.targetPoints || 0),
      rewardDescription: settings.reward.description,
      bills,
    });
  } catch (error) {
    console.error("Error fetching wallet:", error.message);
    res.status(500).json({ message: "Failed to fetch wallet" });
  }
};

// @desc    Resolve a bill for payment. Own bill: send billId only. Someone
//          else's bill: send billId + their registered email or phone.
// @route   POST /api/wallet/resolve-bill
// @access  Protected
export const resolveBill = async (req, res) => {
  const { billId, identifier } = req.body;
  if (!billId) return res.status(400).json({ message: "Bill ID is required" });

  try {
    let targetUserId = req.user._id;
    let customerName = req.user.fullName;

    if (identifier) {
      const owner = await findCustomerByIdentifier(identifier);
      if (!owner) {
        return res.status(404).json({ message: "No registered customer found with that email or phone" });
      }
      targetUserId = owner._id;
      customerName = owner.fullName;
    }

    const receipt = await Receipt.findOne({
      billId: billId.trim(),
      customer: targetUserId,
      status: { $in: ["unpaid", "partial"] },
    });
    if (!receipt) {
      return res.status(404).json({ message: "No payable bill found with that Bill ID for this customer" });
    }

    const items = await attachMenuImages(receipt.items);
    const balanceDue = Number((receipt.subtotal - (receipt.amountPaid || 0)).toFixed(2));

    res.json({
      receiptId: receipt._id,
      billId: receipt.billId,
      customerId: targetUserId,
      customerName,
      status: receipt.status,
      items,
      subtotal: receipt.subtotal,
      amountPaid: receipt.amountPaid || 0,
      balanceDue,
      hasPendingManualPayment: (receipt.pendingManualPayments?.length || 0) > 0,
    });
  } catch (error) {
    console.error("Error resolving bill:", error.message);
    res.status(500).json({ message: "Failed to look up bill" });
  }
};

// @desc    Pay a bill via manual till.
//          - Staff (admin/waiter/manager/cashier acting from the Orders ledger,
//            i.e. req.user.isAdmin) have already verified the till/M-Pesa message
//            in person, so this posts straight to the bill as before.
//          - A customer paying themselves from the wallet is NOT trusted blindly:
//            their submission is queued on the receipt (pendingManualPayments) and
//            the bill stays unpaid/partial until an admin confirms it on the
//            Payments page. This is what "waiting for approval" means everywhere
//            else in the app (customer order list, admin ledger, sidebar toast).
// @route   POST /api/wallet/pay/manual
// @access  Protected
export const payWithManualTill = async (req, res) => {
  const { receiptId, amount, reference } = req.body;

  if (!receiptId || !amount) return res.status(400).json({ message: "Bill and amount are required" });
  if (!reference || !reference.trim()) {
    return res.status(400).json({ message: "Enter the M-Pesa code or your full name as payment proof" });
  }

  try {
    const receipt = await Receipt.findById(receiptId);
    if (!receipt) return res.status(404).json({ message: "Bill not found" });
    if (!["unpaid", "partial"].includes(receipt.status)) {
      return res.status(400).json({ message: "This bill is already settled" });
    }

    const amt = parseFloat(amount);
    const balanceDue = Number((receipt.subtotal - (receipt.amountPaid || 0)).toFixed(2));
    if (isNaN(amt) || amt <= 0) return res.status(400).json({ message: "Enter a valid amount" });
    if (amt > balanceDue) {
      return res.status(400).json({ message: `Amount exceeds the balance due (KES ${balanceDue})` });
    }

    const io = req.app.get("io");

    // Trusted staff entry (Orders ledger "Till" button) — apply immediately.
    if (req.user.isAdmin) {
      const updated = await applyPaymentToReceipt({
        receipt,
        amount: amt,
        method: "manual_till",
        reference: reference.trim(),
        paidBy: req.user._id,
        io,
      });
      return res.json({ message: "Payment recorded", receipt: updated });
    }

    // Customer self-service — queue for admin confirmation, don't touch the balance yet.
    receipt.pendingManualPayments.push({
      amount: amt,
      reference: reference.trim(),
      paidBy: req.user._id,
      paidByName: req.user.fullName,
      submittedAt: new Date(),
    });
    await receipt.save();

    io.emit("receipt:manualPending", { receipt });
    io.emit("receipt:updated", receipt);

    res.json({ message: "Payment submitted — pending confirmation by the restaurant", receipt });
  } catch (error) {
    console.error("Error recording manual payment:", error.message);
    res.status(500).json({ message: "Failed to record payment", error: error.message });
  }
};

// @desc    Pay a bill (own or another's) via M-Pesa STK push, full or partial
// @route   POST /api/wallet/pay/stk
// @access  Protected
export const payWithStk = async (req, res) => {
  const { receiptId, amount, phone } = req.body;
  if (!receiptId || !amount || !phone) {
    return res.status(400).json({ message: "Bill, amount and phone number are required" });
  }

  try {
    const receipt = await Receipt.findById(receiptId);
    if (!receipt) return res.status(404).json({ message: "Bill not found" });
    if (!["unpaid", "partial"].includes(receipt.status)) {
      return res.status(400).json({ message: "This bill is already settled" });
    }

    const amt = parseFloat(amount);
    const balanceDue = Number((receipt.subtotal - (receipt.amountPaid || 0)).toFixed(2));
    if (isNaN(amt) || amt <= 0) return res.status(400).json({ message: "Enter a valid amount" });
    if (amt > balanceDue) {
      return res.status(400).json({ message: `Amount exceeds the balance due (KES ${balanceDue})` });
    }

    const stkRes = await stkPush({
      phone,
      amount: amt,
      accountRef: receipt.billId,
      description: `Bill ${receipt.billId}`,
    });

    if (String(stkRes.ResponseCode) !== "0") {
      return res.status(400).json({ message: stkRes.ResponseDescription || "Failed to initiate M-Pesa payment" });
    }

    receipt.mpesaSource = "wallet";
    receipt.mpesaPhone = phone;
    receipt.mpesaCheckoutRequestId = stkRes.CheckoutRequestID;
    receipt.mpesaMerchantRequestId = stkRes.MerchantRequestID;
    receipt.mpesaStatus = "pending";
    receipt.mpesaResultDesc = null;
    receipt.mpesaReceiptNumber = null;
    receipt.pendingTillAmount = amt;
    receipt.pendingCashAmount = 0;
    receipt.pendingPaidBy = req.user._id;
    await receipt.save();

    const io = req.app.get("io");
    io.emit("receipt:mpesaPending", receipt);

    res.json({
      message: "STK push sent. Enter your M-Pesa PIN to complete payment.",
      checkoutRequestId: stkRes.CheckoutRequestID,
    });
  } catch (error) {
    console.error("Error initiating wallet STK push:", error.response?.data || error.message);
    res.status(500).json({
      message: error.response?.data?.errorMessage || error.message || "Failed to initiate payment",
    });
  }
};

// @desc    Poll a wallet-initiated STK push
// @route   GET /api/wallet/pay/stk/:receiptId/status
// @access  Protected
export const getWalletStkStatus = async (req, res) => {
  try {
    const receipt = await Receipt.findById(req.params.receiptId);
    if (!receipt) return res.status(404).json({ message: "Bill not found" });

    const settled = ["paid", "partial"].includes(receipt.status) && receipt.mpesaStatus === "success";
    res.json({
      status: settled ? "success" : receipt.mpesaStatus || "idle",
      receipt,
    });
  } catch (error) {
    console.error("Error checking wallet STK status:", error.message);
    res.status(500).json({ message: "Failed to check payment status" });
  }
};

// @desc    Pay a bill using the logged-in customer's own reward points
// @route   POST /api/wallet/pay/reward
// @access  Protected
export const payWithReward = async (req, res) => {
  const { receiptId, points } = req.body;
  if (!receiptId) return res.status(400).json({ message: "Bill is required" });

  try {
    const settings = await AdminSettings.getSettings();
    if (!settings.reward.enabled) return res.status(400).json({ message: "Rewards are not enabled" });

    const receipt = await Receipt.findById(receiptId);
    if (!receipt) return res.status(404).json({ message: "Bill not found" });
    if (!["unpaid", "partial"].includes(receipt.status)) {
      return res.status(400).json({ message: "This bill is already settled" });
    }

    const user = req.user;
    if ((user.walletPoints || 0) < (settings.reward.targetPoints || 0)) {
      return res.status(400).json({ message: `You need at least ${settings.reward.targetPoints} points to redeem` });
    }

    const pointsToRedeem = points ? Math.min(parseInt(points), user.walletPoints) : user.walletPoints;
    if (!pointsToRedeem || pointsToRedeem <= 0) {
      return res.status(400).json({ message: "No points available to redeem" });
    }

    const io = req.app.get("io");
    const result = await applyRewardRedemption({ receipt, user, pointsToRedeem, io });

    res.json({
      message: `Applied ${result.pointsUsed} points (KES ${result.kesApplied}) to the bill`,
      receipt: result.receipt,
    });
  } catch (error) {
    console.error("Error paying with reward:", error.message);
    res.status(400).json({ message: error.message || "Failed to redeem points" });
  }
};

// ============================================================
// ADMIN
// ============================================================

// @desc    Admin credits reward points to a registered customer who paid
//          in person, by looking them up via email or phone
// @route   POST /api/wallet/admin/add-reward
// @access  Protected — admin
export const adminAddReward = async (req, res) => {
  const { identifier, amountSpent } = req.body;
  if (!identifier || !amountSpent) {
    return res.status(400).json({ message: "Customer email/phone and amount spent are required" });
  }

  try {
    const customer = await findCustomerByIdentifier(identifier);
    if (!customer) {
      return res.status(404).json({ message: "No registered customer found with that email or phone" });
    }

    const settings = await AdminSettings.getSettings();
    if (!settings.reward.enabled) return res.status(400).json({ message: "Rewards are not enabled" });

    const pointValue = settings.reward.pointValueKes || 1;
    const kesEarned = (parseFloat(amountSpent) * settings.reward.cashbackPercent) / 100;
    const points = Math.floor(kesEarned / pointValue);
    if (points <= 0) return res.status(400).json({ message: "Amount too small to earn a reward point" });

    await User.findByIdAndUpdate(customer._id, { $inc: { walletPoints: points } });

    const RewardTransaction = (await import("../models/RewardTransaction.js")).default;
    await RewardTransaction.create({
      user: customer._id,
      type: "earn",
      points,
      kesEquivalent: Number((points * pointValue).toFixed(2)),
      note: `Manually added by admin for in-person spend of KES ${amountSpent}`,
      createdBy: req.user._id,
    });

    res.json({
      message: `Added ${points} points to ${customer.fullName}`,
      points,
      customer: { id: customer._id, fullName: customer.fullName },
    });
  } catch (error) {
    console.error("Error adding reward:", error.message);
    res.status(500).json({ message: "Failed to add reward" });
  }
};

// @desc    Admin pays a registered customer's bill using that customer's
//          own reward points (e.g. customer is at the till without cash)
// @route   POST /api/wallet/admin/pay-with-reward
// @access  Protected — admin
export const adminPayWithReward = async (req, res) => {
  const { identifier, receiptId, points } = req.body;
  if (!identifier || !receiptId) {
    return res.status(400).json({ message: "Customer email/phone and bill are required" });
  }

  try {
    const customer = await findCustomerByIdentifier(identifier);
    if (!customer) {
      return res.status(404).json({ message: "No registered customer found with that email or phone" });
    }

    const receipt = await Receipt.findById(receiptId);
    if (!receipt) return res.status(404).json({ message: "Bill not found" });
    if (!["unpaid", "partial"].includes(receipt.status)) {
      return res.status(400).json({ message: "This bill is already settled" });
    }

    const pointsToRedeem = points ? Math.min(parseInt(points), customer.walletPoints) : customer.walletPoints;
    if (!pointsToRedeem || pointsToRedeem <= 0) {
      return res.status(400).json({ message: `${customer.fullName} has no reward points available` });
    }

    const io = req.app.get("io");
    const result = await applyRewardRedemption({ receipt, user: customer, pointsToRedeem, io });

    res.json({
      message: `Applied ${result.pointsUsed} points (KES ${result.kesApplied}) from ${customer.fullName}'s reward balance`,
      receipt: result.receipt,
    });
  } catch (error) {
    console.error("Error paying with customer reward:", error.message);
    res.status(400).json({ message: error.message || "Failed to redeem points" });
  }
};

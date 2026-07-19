// utils/walletPayments.js
// Shared logic for applying a payment (or a reward redemption) to a bill —
// used by both the customer wallet flow and the admin M-Pesa callback.
import Order from "../models/Order.js";
import User from "../models/User.js";
import RewardTransaction from "../models/RewardTransaction.js";
import AdminSettings from "../models/AdminSettings.js";

// Cashback earned on a given amount, per the current reward settings.
export const computeCashback = (amountKes, settings) => {
  if (!settings?.reward?.enabled || !settings.reward.cashbackPercent) {
    return { points: 0, kes: 0 };
  }
  const pointValue = settings.reward.pointValueKes || 1;
  const kesEarned = (amountKes * settings.reward.cashbackPercent) / 100;
  const points = Math.floor(kesEarned / pointValue);
  return { points, kes: Number((points * pointValue).toFixed(2)) };
};

// Record a payment entry on a bill, roll up the running total, flip status
// to partial/paid, and credit any cashback to the bill's registered customer.
// Does NOT save `receipt` for the caller — callers should have already set
// any of their own fields (e.g. mpesaStatus) before calling, since this
// function performs the single `receipt.save()`.
export const applyPaymentToReceipt = async ({ receipt, amount, method, reference, paidBy, io }) => {
  amount = Number(Number(amount).toFixed(2));

  receipt.payments.push({ amount, method, reference: reference || null, paidBy: paidBy || null, paidAt: new Date() });
  receipt.paymentMethod = method;

  const totalPaid = receipt.payments.reduce((sum, p) => sum + p.amount, 0);
  receipt.amountPaid = Number(totalPaid.toFixed(2));
  receipt.status = totalPaid >= receipt.subtotal ? "paid" : "partial";
  if (receipt.status === "paid") receipt.paidAt = new Date();

  if (receipt.customer) {
    const settings = await AdminSettings.getSettings();
    const { points, kes } = computeCashback(amount, settings);
    if (points > 0) {
      receipt.rewardPointsEarned = (receipt.rewardPointsEarned || 0) + points;
      await User.findByIdAndUpdate(receipt.customer, { $inc: { walletPoints: points } });
      await RewardTransaction.create({
        user: receipt.customer,
        type: "earn",
        points,
        kesEquivalent: kes,
        receipt: receipt._id,
        note: `Cashback on payment of KES ${amount} for bill ${receipt.billId}`,
      });
    }
  }

  await receipt.save();

  if (receipt.status === "paid") {
    await Order.findByIdAndUpdate(receipt.order, { status: "completed" });
  }

  if (io) {
    io.emit("receipt:updated", receipt);
    if (receipt.status === "paid") io.emit("receipt:paid", receipt);
  }

  return receipt;
};

// Redeem `pointsToRedeem` from `user`'s reward balance against `receipt`'s
// balance due. Redeems less than requested if the balance due is smaller.
export const applyRewardRedemption = async ({ receipt, user, pointsToRedeem, io }) => {
  const settings = await AdminSettings.getSettings();
  const pointValue = settings.reward.pointValueKes || 1;

  const balanceDue = Number((receipt.subtotal - (receipt.amountPaid || 0)).toFixed(2));
  if (balanceDue <= 0) throw new Error("This bill has no balance due");

  const requestedKes = pointsToRedeem * pointValue;
  const amountToApply = Number(Math.min(requestedKes, balanceDue).toFixed(2));
  const pointsUsed = Math.ceil(amountToApply / pointValue);

  if (pointsUsed > (user.walletPoints || 0)) {
    throw new Error("Insufficient reward points");
  }

  receipt.payments.push({
    amount: amountToApply,
    method: "reward",
    reference: `${pointsUsed} pts redeemed`,
    paidBy: user._id,
    paidAt: new Date(),
  });
  receipt.paymentMethod = "reward";

  const totalPaid = receipt.payments.reduce((sum, p) => sum + p.amount, 0);
  receipt.amountPaid = Number(totalPaid.toFixed(2));
  receipt.rewardPointsRedeemed = (receipt.rewardPointsRedeemed || 0) + pointsUsed;
  receipt.rewardKesRedeemed = Number(((receipt.rewardKesRedeemed || 0) + amountToApply).toFixed(2));
  receipt.status = totalPaid >= receipt.subtotal ? "paid" : "partial";
  if (receipt.status === "paid") receipt.paidAt = new Date();

  await receipt.save();
  await User.findByIdAndUpdate(user._id, { $inc: { walletPoints: -pointsUsed } });
  await RewardTransaction.create({
    user: user._id,
    type: "redeem",
    points: -pointsUsed,
    kesEquivalent: -amountToApply,
    receipt: receipt._id,
    note: `Redeemed against bill ${receipt.billId}`,
  });

  if (receipt.status === "paid") {
    await Order.findByIdAndUpdate(receipt.order, { status: "completed" });
  }

  if (io) {
    io.emit("receipt:updated", receipt);
    if (receipt.status === "paid") io.emit("receipt:paid", receipt);
  }

  return { receipt, pointsUsed, kesApplied: amountToApply };
};

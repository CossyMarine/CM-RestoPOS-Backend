// models/RewardTransaction.js
import mongoose from "mongoose";

const rewardTransactionSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    // Signed delta actually applied to the user's walletPoints balance
    type: { type: String, enum: ["earn", "redeem", "adjustment"], required: true },
    points: { type: Number, required: true },
    kesEquivalent: { type: Number, default: 0 },
    receipt: { type: mongoose.Schema.Types.ObjectId, ref: "Receipt", default: null },
    note: { type: String, default: null },
    // Set when an admin manually added/adjusted the reward; null if system-earned
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

export default mongoose.model("RewardTransaction", rewardTransactionSchema);

// models/RewardTransaction.js
import mongoose from "mongoose";
import tenantGuard from "../Middlewares/plugins/tenantGuard.js";

const rewardTransactionSchema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Business",
      required: true,
      index: true,
    },
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

rewardTransactionSchema.index({ businessId: 1, user: 1, createdAt: -1 });
rewardTransactionSchema.plugin(tenantGuard);

export default mongoose.model("RewardTransaction", rewardTransactionSchema);
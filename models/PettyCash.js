// models/PettyCash.js
import mongoose from "mongoose";

const pettyCashSchema = new mongoose.Schema(
  {
    shift:    { type: mongoose.Schema.Types.ObjectId, ref: "Shift", required: true },
    amount:   { type: Number, required: true },
    reason:   { type: String, required: true },
    loggedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Business",
      required: true,
      index: true,
    },
  },
  { timestamps: true }
);

export default mongoose.model("PettyCash", pettyCashSchema);

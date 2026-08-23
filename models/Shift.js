// models/Shift.js
import mongoose from "mongoose";

const shiftSchema = new mongoose.Schema(
  {
    openedBy:     { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    openingFloat: { type: Number, required: true },
    status: { type: String, enum: ["open", "closed"], default: "open" },

    closingCashCount: { type: Number, default: null },
    closingTillCount: { type: Number, default: null },
    tipsDeclared:     { type: Number, default: 0 },
    notes:            { type: String, default: null },

    closedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    closedAt: { type: Date, default: null },
  },
  { timestamps: true } // createdAt doubles as "openedAt"
);

export default mongoose.model("Shift", shiftSchema);

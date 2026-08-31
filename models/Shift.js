// models/Shift.js
import mongoose from "mongoose";
import tenantGuard from "../Middlewares/plugins/tenantGuard.js";

const shiftSchema = new mongoose.Schema(
  {
    openedBy:     { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    openingFloat: { type: Number, required: true },
    status: { type: String, enum: ["open", "closed"], default: "open" },

    closingCashCount: { type: Number, default: null },
    closingTillCount: { type: Number, default: null },
    tipsDeclared:     { type: Number, default: 0 },
    notes:            { type: String, default: null },
businessId: {
  type: mongoose.Schema.Types.ObjectId,
  ref: "Business",
  required: true,
  index: true,
},
    closedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    closedAt: { type: Date, default: null },
  },
  { timestamps: true } // createdAt doubles as "openedAt"
);
// models/Shift.js
shiftSchema.index({ businessId: 1, openedBy: 1, status: 1 });
shiftSchema.index({ businessId: 1, createdAt: -1 });
shiftSchema.plugin(tenantGuard);
export default mongoose.model("Shift", shiftSchema);

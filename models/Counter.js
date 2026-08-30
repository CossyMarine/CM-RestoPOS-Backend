// models/Counter.js
import mongoose from "mongoose";
import tenantGuard from "../Middlewares/plugins/tenantGuard.js";

const counterSchema = new mongoose.Schema({
  name: { type: String, required: true },
  seq: { type: Number, default: 0 },
  businessId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Business",
    required: true,
    index: true,
  },
});

counterSchema.index({ businessId: 1, name: 1 }, { unique: true });
counterSchema.plugin(tenantGuard);

export default mongoose.model("Counter", counterSchema);
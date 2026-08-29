import mongoose from "mongoose";
import tenantGuard from "../Middlewares/plugins/tenantGuard.js";

const supplierSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    phone: { type: String, trim: true, default: "" },
    email: { type: String, trim: true, default: "" },
    address: { type: String, trim: true, default: "" },
    contactPerson: { type: String, trim: true, default: "" },
    note: { type: String, trim: true, default: "" },
    isActive: { type: Boolean, default: true },
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Business",
      required: true,
      index: true,
    },
  },
  { timestamps: true }
);

supplierSchema.index({ name: 1 }, { unique: true });

const Supplier = mongoose.model("Supplier", supplierSchema);

export default Supplier;

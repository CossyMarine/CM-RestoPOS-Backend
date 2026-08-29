// models/MenuItem.js
import mongoose from "mongoose";
import tenantGuard from "../Middlewares/plugins/tenantGuard.js";

const menuItemSchema = new mongoose.Schema(
  {
    name:          { type: String, required: true },
    description:   { type: String, default: "" },
    price:         { type: Number, required: true },
    category:      { type: String, default: "main" },
    imageUrl:      { type: String, default: null },
    imagePublicId: { type: String, default: null },
    isAvailable:   { type: Boolean, default: true },
    pinned:        { type: Boolean, default: false },
    pinOrder:      { type: Number, default: 0 },
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Business",
      required: true,
      index: true,
    },
  },
  { timestamps: true }
);
menuItemSchema.plugin(tenantGuard);

export default mongoose.model("MenuItem", menuItemSchema);

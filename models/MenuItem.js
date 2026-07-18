// models/MenuItem.js
import mongoose from "mongoose";

const menuItemSchema = new mongoose.Schema(
  {
    name:          { type: String, required: true },
    description:   { type: String, default: "" },
    price:         { type: Number, required: true },
    category:      { type: String, default: "main" },
    imageUrl:      { type: String, default: null },
    imagePublicId: { type: String, default: null },
    isAvailable:   { type: Boolean, default: true },
  },
  { timestamps: true }
);

export default mongoose.model("MenuItem", menuItemSchema);

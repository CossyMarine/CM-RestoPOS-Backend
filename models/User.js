// models/User.js
import mongoose from "mongoose";

const userSchema = new mongoose.Schema(
  {
    fullName: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      unique: true,
      sparse: true, // allows many docs with no email
    },
    phone: {
      type: String,
      trim: true,
      unique: true,
      sparse: true, // allows many docs with no phone
    },
    password: { type: String, required: true }, // bcrypt hash

    // Marine-style flag — true = full-access staff (was admin/manager/cashier).
    // isAdmin: true always routes to /admin regardless of `role`.
    isAdmin: {
      type: Boolean,
      default: false,
    },

    // Only meaningful when isAdmin is false.
    role: {
      type: String,
      enum: ["kitchen", "waiter", "accountant", "customer"],
      default: "customer",
    },

    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export default mongoose.model("User", userSchema);

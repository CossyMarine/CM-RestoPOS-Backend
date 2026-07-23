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

    // Reward/cashback points balance — only meaningful for role: "customer"
    walletPoints: { type: Number, default: 0 },

    // ---- Waiter management metadata (role: "waiter" only) ----
    // When/how this user became a waiter.
    waiterSince: { type: Date },
    waiterSource: { type: String, enum: ["direct", "promoted"], default: "direct" },

    // Global kill-switch — true = never appears in ANYONE's waiter dropdown.
    // Set automatically when a waiter is "dropped" via admin management.
    hiddenFromSelector: { type: Boolean, default: false },

    // Per-waiter selector control — governs what THIS waiter sees in their
    // own "assign/select waiter" dropdown after logging in.
    // "all"    = sees every active, non-globally-hidden waiter (default/legacy behavior)
    // "custom" = sees only themselves + the waiters listed in visibleWaiters
    selectorMode: { type: String, enum: ["all", "custom"], default: "all" },
    visibleWaiters: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
  },
  { timestamps: true }
);

export default mongoose.model("User", userSchema);

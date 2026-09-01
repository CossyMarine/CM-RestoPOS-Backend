// models/User.js
import mongoose from "mongoose";
import tenantGuard from "../Middlewares/plugins/tenantGuard.js";

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
},
    phone: {
  type: String,
  trim: true,
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
  enum: ["superadmin", "kitchen", "waiter", "accountant", "customer"],
  default: "customer",
},
businessId: {
  type: mongoose.Schema.Types.ObjectId,
  ref: "Business",
  required: function () {
    return this.role !== "superadmin";
  },
},
    isActive: { type: Boolean, default: true },

        // ---- Granular module access (role: "accountant" only) ----
    // Payments, Orders & Receipts, and Void Requests are visible by default —
    // they're the core of the accountant job. Everything else is hidden
    // until an admin explicitly grants it from Accountant Management.
    permissions: {
      inventory: { type: Boolean, default: false },
      manageMenu: { type: Boolean, default: false },
      ordersReceipts: { type: Boolean, default: true },
      voidRequests: { type: Boolean, default: true },
      users: { type: Boolean, default: false },
      settings: { type: Boolean, default: false },
      waiterManagement: { type: Boolean, default: false },
      kitchen: { type: Boolean, default: false },
       paymentConfirmation: { type: Boolean, default: false },
      payments: { type: Boolean, default: true },
      applyDiscounts: { type: Boolean, default: false },
    },

    // Reward/cashback points balance — only meaningful for role: "customer"
    walletPoints: { type: Number, default: 0 },

    // ---- Waiter management metadata (role: "waiter" only) ----
    // When/how this user became a waiter.
    waiterSince: { type: Date },
    waiterSource: { type: String, enum: ["direct", "promoted"], default: "direct" },

    // Global kill-switch — true = never appears in ANYONE's waiter dropdown.
    // Set automatically when a waiter is "dropped" via admin management.
    hiddenFromSelector: { type: Boolean, default: false },

    // Password reset (forgot password) — numeric code flow
resetCode: { type: String, select: false },            // sha256 hash of the 6-digit code
resetCodeExpires: { type: Date, select: false },
resetCodeAttempts: { type: Number, default: 0, select: false },
resetCodeChannel: { type: String, enum: ["email", "sms", "whatsapp"], select: false },
resetCodeLastSentAt: { type: Date, select: false },     // cooldown for resend

resetToken: { type: String, select: false },            // short-lived token after code is verified
resetTokenExpires: { type: Date, select: false },

    // Per-waiter selector control — governs what THIS waiter sees in their
    // own "assign/select waiter" dropdown after logging in.
    // "all"    = sees every active, non-globally-hidden waiter (default/legacy behavior)
    // "custom" = sees only themselves + the waiters listed in visibleWaiters
    selectorMode: { type: String, enum: ["all", "custom"], default: "all" },
    visibleWaiters: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
  },
  { timestamps: true }
);
// models/User.js
userSchema.index({ businessId: 1, role: 1, isActive: 1, fullName: 1 });
userSchema.index(
  { businessId: 1, email: 1 },
  { unique: true, partialFilterExpression: { email: { $type: "string" } } }
);
userSchema.index(
  { businessId: 1, phone: 1 },
  { unique: true, partialFilterExpression: { phone: { $type: "string" } } }
);
userSchema.plugin(tenantGuard);
export default mongoose.model("User", userSchema);

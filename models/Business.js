// models/Business.js
import mongoose from "mongoose";

const businessSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },

    phone: { type: String, trim: true, unique: true, sparse: true },
    email: { type: String, trim: true, lowercase: true, unique: true, sparse: true },

    // Kenya Revenue Authority PIN — used for tax/receipt compliance,
    // not enforced unique in case a business hasn't registered one yet
    kraPin: { type: String, trim: true, uppercase: true, sparse: true },

    // Lifecycle of the tenant itself (not billing — see subscriptionStatus)
    status: {
      type: String,
      enum: ["active", "suspended", "pending", "closed"],
      default: "pending",
    },

    // Billing plan tier
    plan: {
      type: String,
      enum: ["trial", "basic", "pro", "enterprise"],
      default: "trial",
    },

    subscriptionStatus: {
      type: String,
      enum: ["trialing", "active", "past_due", "canceled", "expired"],
      default: "trialing",
    },
    subscriptionStart: { type: Date },
    subscriptionExpires: { type: Date },

    // Flexible bag for per-business config (currency, timezone, receipt
    // footer text, etc.) so you don't need a migration for every new toggle
    settings: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  { timestamps: true } // gives you createdAt + updatedAt for free
);

export default mongoose.model("Business", businessSchema);
// models/AdminSettings.js
import mongoose from "mongoose";

const rewardSettingsSchema = new mongoose.Schema(
  {
    enabled: { type: Boolean, default: false },
    // % of amount paid that converts into reward value, e.g. 5 = 5% cashback
    cashbackPercent: { type: Number, default: 0 },
    // KES value of 1 point when redeeming, e.g. 1 (1 point = 1 KES) or 100 (1 point = 100 KES)
    pointValueKes: { type: Number, default: 1 },
    // Minimum points balance a customer must reach before they can redeem
    targetPoints: { type: Number, default: 0 },
    description: { type: String, default: "" },
  },
  { _id: false }
);

const adminSettingsSchema = new mongoose.Schema(
  {
    // Singleton lock — only one document ever exists
    key: { type: String, default: "global", unique: true },

    // Manual till shown to customers who pay via "Till" instead of STK
    tillNumber: { type: String, default: null },
    tillName: { type: String, default: null },

    // Bouncing WhatsApp icon on the customer home page
    whatsappNumber: { type: String, default: null },
    // "Call to manage" number shown on the profile page
    callNumber: { type: String, default: null },

    // Table Number Behavior
    assumeTableNumberCustomer: { type: Boolean, default: false },
    assumeTableNumberWaiter: { type: Boolean, default: false },

    // When true, a receipt automatically prints (with payment breakdown)
    // the moment a bill becomes fully paid. Defaults to off.
    allowPrintingDuringPayment: { type: Boolean, default: false },

    reward: { type: rewardSettingsSchema, default: () => ({}) },
    tax: { type: taxSettingsSchema, default: () => ({}) },
  },
  { timestamps: true }
);

// Fetch the single settings document, creating it with defaults on first use.
adminSettingsSchema.statics.getSettings = async function () {
  let settings = await this.findOne({ key: "global" });
  if (!settings) settings = await this.create({ key: "global" });
  return settings;
};
const taxSettingsSchema = new mongoose.Schema(
  {
    enabled: { type: Boolean, default: true },
    ratePercent: { type: Number, default: 16 }, // e.g. 16 = 16% VAT — admin can change this any time
    inclusive: { type: Boolean, default: true }, // true = menu prices already include tax; false = tax added on top
  },
  { _id: false }
);
export default mongoose.model("AdminSettings", adminSettingsSchema);

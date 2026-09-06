// models/PaymentConfig.js
import mongoose from "mongoose";
import tenantGuard from "../Middlewares/plugins/tenantGuard.js";
import { encrypt, decrypt } from "../utils/encryption.js";

const paymentConfigSchema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Business",
      required: true,
    },

    provider: {
      type: String,
      enum: ["mpesa"], // extend later: "stripe", "flutterwave", etc.
      required: true,
      default: "mpesa",
    },

    shortcode: { type: String, trim: true, required: true },

    // Stored ENCRYPTED (iv.authTag.ciphertext). select: false keeps them out
    // of default query results and out of accidental console.log(doc) leaks —
    // callers must explicitly .select("+consumerKey") to touch the raw field,
    // and should generally go through getDecryptedCredentials() instead.
    consumerKey: { type: String, required: true, select: false },
    consumerSecret: { type: String, required: true, select: false },
    passkey: { type: String, required: true, select: false },

    environment: {
      type: String,
      enum: ["sandbox", "production"],
      default: "sandbox",
    },

    enabled: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// One config per business per provider.
paymentConfigSchema.index({ businessId: 1, provider: 1 }, { unique: true });

paymentConfigSchema.plugin(tenantGuard);

// Belt-and-suspenders: even if someone forgets `select: false` protection
// somewhere down the line, never let these fields survive a JSON response.
paymentConfigSchema.set("toJSON", {
  transform: (doc, ret) => {
    delete ret.consumerKey;
    delete ret.consumerSecret;
    delete ret.passkey;
    return ret;
  },
});
paymentConfigSchema.set("toObject", {
  transform: (doc, ret) => {
    delete ret.consumerKey;
    delete ret.consumerSecret;
    delete ret.passkey;
    return ret;
  },
});

// Instance method — the ONLY sanctioned way to get plaintext credentials,
// used at the point of actually calling the M-Pesa API.
paymentConfigSchema.methods.getDecryptedCredentials = function () {
  return {
    consumerKey: decrypt(this.consumerKey),
    consumerSecret: decrypt(this.consumerSecret),
    passkey: decrypt(this.passkey),
  };
};

// Static — upsert with encryption applied on the way in. Controllers should
// call this rather than constructing/saving a PaymentConfig by hand, so
// nobody accidentally saves plaintext by skipping the encrypt step.
paymentConfigSchema.statics.upsertForBusiness = async function (
  businessId,
  provider,
  { shortcode, consumerKey, consumerSecret, passkey, environment, enabled }
) {
  const update = {
    businessId,
    provider,
    ...(shortcode !== undefined && { shortcode }),
    ...(consumerKey !== undefined && { consumerKey: encrypt(consumerKey) }),
    ...(consumerSecret !== undefined && { consumerSecret: encrypt(consumerSecret) }),
    ...(passkey !== undefined && { passkey: encrypt(passkey) }),
    ...(environment !== undefined && { environment }),
    ...(enabled !== undefined && { enabled }),
  };

  return this.findOneAndUpdate(
    { businessId, provider },
    { $set: update },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
};

export default mongoose.model("PaymentConfig", paymentConfigSchema);
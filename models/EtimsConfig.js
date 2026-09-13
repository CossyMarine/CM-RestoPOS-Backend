// models/EtimsConfig.js
import mongoose from "mongoose";
import tenantGuard from "../Middlewares/plugins/tenantGuard.js";
import { encrypt, decrypt } from "../utils/encryption.js";

const etimsConfigSchema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Business",
      required: true,
      index: true,
    },

    // Free-form provider identifier (e.g. "tremol", "kra-oscu-generic",
    // "wowvasco"), deliberately NOT an enum. Which providers are actually
    // implemented is a concern for the future eTIMSService/provider-adapter
    // layer, not this model — the schema must not assume, restrict, or
    // hardcode which integrators exist.
    provider: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },

    // Device/registration details a KRA integrator needs (device serial,
    // branch/terminal code, control unit ID, etc.). Shape varies by
    // provider, so this is intentionally untyped rather than a fixed set
    // of named fields — do not add provider-specific keys to the schema
    // itself; put them inside this object instead.
    deviceInfo: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },

    // Provider credentials/secrets, ENCRYPTED as a single opaque blob
    // (iv.authTag.ciphertext, via the same utils/encryption.js used by
    // PaymentConfig). Stored as one encrypted JSON string rather than
    // named encrypted fields (contrast with PaymentConfig's
    // consumerKey/consumerSecret/passkey) because different eTIMS
    // providers need different credential shapes (API key + secret,
    // certificate + private key, username/password/device serial, etc.) —
    // hardcoding named fields here would tie this model to the first
    // provider integrated. select: false keeps it out of default query
    // results and accidental console.log(doc) leaks, same convention as
    // PaymentConfig.
    credentials: {
      type: String,
      select: false,
      default: null,
    },

    environment: {
      type: String,
      enum: ["sandbox", "production"],
      default: "sandbox",
    },

    enabled: {
      type: Boolean,
      default: false,
    },

    // Configuration/connection health of THIS config row — not to be
    // confused with per-invoice transmission status, which belongs to
    // EtimsSubmission and is out of scope for this model.
    status: {
      type: String,
      enum: ["not_configured", "configured", "verified", "error"],
      default: "not_configured",
    },
    statusMessage: {
      type: String,
      default: null,
    },
    lastVerifiedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

// One config document per (business, provider) pair — same pattern as
// PaymentConfig's { businessId, provider } unique index. Lets a business
// hold configuration for more than one provider over time (e.g. trialing
// a new integrator) without them colliding.
etimsConfigSchema.index({ businessId: 1, provider: 1 }, { unique: true });

// At most ONE enabled config per business at any time. A business can have
// several disabled/inactive provider configs on file, but only one may be
// the live, active one — this is what "different providers per Business"
// means in practice (one active at a time, switchable), not several
// simultaneously-active configs racing each other.
etimsConfigSchema.index(
  { businessId: 1, enabled: 1 },
  { unique: true, partialFilterExpression: { enabled: true } }
);

etimsConfigSchema.plugin(tenantGuard);

// Belt-and-suspenders: even if select:false is ever bypassed somewhere,
// never let the encrypted credentials blob leave the server in a response.
etimsConfigSchema.set("toJSON", {
  transform: (doc, ret) => {
    delete ret.credentials;
    return ret;
  },
});
etimsConfigSchema.set("toObject", {
  transform: (doc, ret) => {
    delete ret.credentials;
    return ret;
  },
});

// The ONLY sanctioned way to get plaintext credentials back out. Returns
// {} if none have been configured yet, rather than throwing, so callers
// can check `Object.keys(creds).length === 0` for "not configured" without
// a try/catch. The caller must have already `.select("+credentials")`'d,
// same convention as PaymentConfig.getDecryptedCredentials().
etimsConfigSchema.methods.getDecryptedCredentials = function () {
  if (!this.credentials) return {};
  const raw = decrypt(this.credentials);
  return raw ? JSON.parse(raw) : {};
};

// Convenience only — resolves this business's KRA PIN from the canonical
// source (Business.kraPin, see the design note in the report). Does not
// cache or duplicate the value on this document.
etimsConfigSchema.methods.getKraPin = async function () {
  const Business = mongoose.model("Business");
  const business = await Business.findOne({
    _id: this.businessId,
    _bypassTenantGuard: true,
  }).select("kraPin");
  return business?.kraPin || null;
};

// Upsert with encryption applied on the way in — controllers should call
// this rather than constructing/saving an EtimsConfig by hand, so nobody
// accidentally persists plaintext credentials by skipping the encrypt step.
// `credentials` and `deviceInfo` are accepted as plain objects of whatever
// shape the chosen provider needs; this static does not interpret or
// validate their contents.
etimsConfigSchema.statics.upsertForBusiness = async function (
  businessId,
  provider,
  { deviceInfo, credentials, environment, enabled, status, statusMessage } = {}
) {
  const update = {
    businessId,
    provider,
    ...(deviceInfo !== undefined && { deviceInfo }),
    ...(credentials !== undefined && {
      credentials: credentials === null ? null : encrypt(JSON.stringify(credentials)),
    }),
    ...(environment !== undefined && { environment }),
    ...(enabled !== undefined && { enabled }),
    ...(status !== undefined && { status }),
    ...(statusMessage !== undefined && { statusMessage }),
  };

  return this.findOneAndUpdate(
    { businessId, provider },
    { $set: update },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
};

export default mongoose.model("EtimsConfig", etimsConfigSchema);
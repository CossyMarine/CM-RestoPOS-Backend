// utils/etimsService.js
// Provider-neutral eTIMS service. This is the ONLY module the rest of the
// POS (Agenda jobs, controllers, Receipt) should ever talk to for eTIMS
// submission — nothing outside this file and utils/etimsProviders/ should
// know which provider is configured, how its credentials are shaped, or
// how it's actually called.
import EtimsConfig from "../models/EtimsConfig.js";
import { getProviderAdapter } from "./etimsProviders/index.js";
import { EtimsConfigurationError, EtimsProviderError } from "./etimsErrors.js";

// Provider-neutral invoice data every adapter receives, regardless of
// provider. Deliberately mirrors exactly the fields the current
// EtimsSubmission/receipt flow already relies on (see the original
// utils/etims.js payload) — no new fields invented this phase.
 export function buildInvoiceData({ receipt, kraPin, invoiceNumber }) {
  return {
    invoiceNumber,
    taxPin: kraPin,
    items: receipt.items.map((i) => ({
      description: i.mealName,
      quantity: i.quantity,
      unitPrice: i.unitPrice,
      total: i.lineTotal,
    })),
    totalAmount: receipt.totalDue ?? receipt.subtotal,
    taxAmount: receipt.tax?.amount ?? 0,
    timestamp: receipt.paidAt || new Date(),
  };
}

// @param businessId — REQUIRED. The one lookup in this entire pipeline
//   that must never cross tenants, since it determines whose credentials
//   get used. Always passed explicitly by the caller (the Agenda job
//   already has it on the EtimsSubmission document) — never resolved any
//   other way, and never bypassed.
// @param receipt — the paid Receipt document to submit.
// @returns { invoiceNumber, raw } on success.
// @throws EtimsConfigurationError | EtimsTemporaryError | EtimsPermanentError
// AFTER
export async function submitInvoice({ businessId, receipt, invoiceNumber }) {
  if (!businessId) {
    throw new EtimsConfigurationError("submitInvoice called without a businessId");
  }
  if (!invoiceNumber) {
    throw new EtimsConfigurationError("submitInvoice called without an invoiceNumber");
  }

  // Scoped explicitly by businessId (not _bypassTenantGuard) — this is the
  // one query in the whole eTIMS pipeline that decides which business's
  // credentials get used, so it must always carry a real businessId filter.
  const config = await EtimsConfig.findOne({
    businessId,
    enabled: true,
  }).select("+credentials");

  if (!config) {
    throw new EtimsConfigurationError(
      "No enabled eTIMS provider is configured for this business yet"
    );
  }

  // Business.kraPin remains canonical (see EtimsConfig's design note) —
  // resolved here, not stored/cached on the config document.
  const kraPin = await config.getKraPin();

  // Decrypted only now, at the point of actual use — never held anywhere
  // longer than this function call.
  const credentials = config.getDecryptedCredentials();

  const adapter = getProviderAdapter(config.provider);
// AFTER
const invoice = buildInvoiceData({ receipt, kraPin, invoiceNumber });
  try {
    return await adapter.submitInvoice({
      invoice,
      credentials,
      deviceInfo: config.deviceInfo || {},
    });
  } catch (error) {
    // Adapters are required to throw EtimsProviderError subclasses. If a
    // future adapter has a bug and throws something else, don't let an
    // unclassified error slip through the boundary silently — wrap it so
    // the shape stays predictable, defaulting to "temporary" since that's
    // the safer assumption (retry rather than silently give up).
    if (error instanceof EtimsProviderError) throw error;
    throw new EtimsProviderError(error.message, { classification: "temporary", cause: error });
  }
}
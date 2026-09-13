// utils/etimsInvoiceNumbering.js
// Business-scoped eTIMS invoice numbering. Reuses the existing Counter
// model/mechanism that already backs Receipt.billId — a separate counter
// DOCUMENT (name: "etims-invoice"), entirely independent of the "bill"
// counter, so eTIMS numbering can never collide with or be influenced by
// POS bill numbering. No new model — Counter already provides everything
// this needs: a { businessId, name } unique index and atomic $inc.
import Counter from "../models/Counter.js";

// Atomically allocates and returns the next raw sequence number for this
// business's eTIMS invoices. A single findOneAndUpdate + $inc is one
// indivisible operation at the MongoDB storage-engine level — concurrent
// calls for the same businessId are serialized by Mongo itself, so two
// callers can never receive the same value. This is the exact mechanism
// already trusted in production for Receipt.billId (see
// utils/generateReceipt.js) — not a new or separately-proven pattern.
export async function allocateNextEtimsInvoiceSequence(businessId) {
  const counter = await Counter.findOneAndUpdate(
    { businessId, name: "etims-invoice" },
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  return counter.seq;
}

// Display-format boundary — deliberately separate from the raw numeric
// sequence, and deliberately unopinionated. No KRA-specific format
// (prefixing, padding, checksums, etc.) is assumed here; this is a
// placeholder until real provider/integrator format requirements are
// confirmed. Change ONLY this function when that's known — the sequence
// allocation above never needs to change to support a new display format.
export function formatEtimsInvoiceNumber(sequence) {
  return String(sequence);
}
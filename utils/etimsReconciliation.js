// utils/etimsReconciliation.js
// Read-only eTIMS reconciliation. Answers "what state is this business's
// eTIMS submissions in, and what needs a human to look at it" purely from
// the POS's own persisted EtimsSubmission/Receipt records.
//
// Deliberately NOT a provider integration: there is no real KRA/integrator
// reconciliation API yet, so this never calls out to a provider or
// pretends to know a submission's true remote state. It only reasons about
// what the POS itself already recorded. When a real provider reconciliation
// API exists, that lookup can be added as an additional, separate step
// layered on top of (not replacing) this function — the shape returned
// here (submissionId/invoiceNumber/status/etc.) is designed to be exactly
// what such a step would need per-record to cross-check against the
// provider.
//
// This module never writes anything — no retries, no status changes, no
// deletes. It is purely a report.
import EtimsSubmission from "../models/EtimsSubmission.js";
import Receipt from "../models/Receipt.js";

// Mirrors EtimsSubmission.status enum exactly (see models/EtimsSubmission.js).
// Kept as an explicit list (rather than reading the schema enum at runtime)
// so a status added to the schema later doesn't silently start being
// tallied — it will show up under `counts.unrecognized` instead, which is
// itself a useful "this reconciliation logic is now stale" signal.
const KNOWN_STATUSES = ["queued", "processing", "submitted", "failed", "failed-permanent"];

// Purely informational staleness threshold for flagging a submission that
// has sat in "queued"/"processing" far longer than a healthy pipeline
// should take — NOT the same thing as, and not a replacement for, the
// Agenda job's own 5-minute stale-processing reclaim window (see
// STALE_PROCESSING_MS in jobs/etimsJob.js, which this file does not touch).
// This is a much longer, human-attention-scale window: a submission stuck
// here for over an hour suggests the job isn't running at all, not just a
// single slow attempt.
const STALE_PENDING_MS = 60 * 60 * 1000; // 1 hour

function isStalePending(submission, now) {
  if (submission.status !== "queued" && submission.status !== "processing") return false;
  const reference = submission.processingStartedAt || submission.updatedAt || submission.createdAt;
  if (!reference) return false;
  return now - new Date(reference).getTime() > STALE_PENDING_MS;
}

// Shapes one EtimsSubmission (optionally populated with its Receipt) into
// the flat record described in the reconciliation requirements: invoice
// number, receipt reference, status, last error, attempt count, timestamps.
function toRecord(submission, reasons) {
  const receipt =
    submission.receiptId && typeof submission.receiptId === "object" ? submission.receiptId : null;

  return {
    type: "submission",
    submissionId: submission._id,
    receiptId: receipt ? receipt._id : submission.receiptId,
    receiptBillId: receipt ? receipt.billId : null,
    invoiceNumber: submission.assignedInvoiceNumber, // per requirements: never billId
    providerInvoiceNumber: submission.etimsInvoiceNumber,
    status: submission.status,
    attempts: submission.attempts,
    lastError: submission.lastError,
    processingStartedAt: submission.processingStartedAt,
    submittedAt: submission.submittedAt,
    createdAt: submission.createdAt,
    updatedAt: submission.updatedAt,
    reasons,
  };
}

// @param businessId — REQUIRED, explicit, same convention as
//   etimsService.submitInvoice: the one thing that must never be resolved
//   implicitly or bypassed. Callers (business-scoped controller or
//   superadmin acting on a specific, explicitly chosen business) are always
//   responsible for supplying it.
// @returns a summary + list of records needing attention. Never mutates
//   any EtimsSubmission or Receipt document.
export async function reconcileEtimsSubmissions(businessId) {
  if (!businessId) {
    throw new Error("reconcileEtimsSubmissions requires a businessId");
  }

  const now = Date.now();

  // Explicit businessId filter — passes tenantGuard on its own merits, no
  // _bypassTenantGuard escape hatch needed or used.
  const submissions = await EtimsSubmission.find({ businessId })
    .populate({ path: "receiptId", select: "billId status paidAt" })
    .sort({ createdAt: -1 })
    .lean();

  const counts = {
    submitted: 0,
    queued: 0,
    processing: 0,
    failed: 0,
    "failed-permanent": 0,
    unrecognized: 0,
  };

  const needsAttention = [];

  for (const submission of submissions) {
    if (KNOWN_STATUSES.includes(submission.status)) {
      counts[submission.status]++;
    } else {
      counts.unrecognized++;
    }

    const reasons = [];
    if (submission.status === "failed") reasons.push("failed");
    if (submission.status === "failed-permanent") reasons.push("failed-permanent");
    if (isStalePending(submission, now)) reasons.push("stale-pending");
    // A "submitted" row missing the provider's own confirmation number, or
    // missing the invoice number we assigned it, is internally
    // inconsistent — worth surfacing even though nothing here claims to
    // know why. Determined entirely from what's already persisted, no
    // provider call involved.
    if (submission.status === "submitted" && !submission.etimsInvoiceNumber) {
      reasons.push("submitted-without-provider-confirmation");
    }
    if (submission.status === "submitted" && !submission.assignedInvoiceNumber) {
      reasons.push("submitted-without-assigned-invoice-number");
    }

    if (reasons.length > 0) {
      needsAttention.push(toRecord(submission, reasons));
    }
  }

  // Missing-relationship check: every Receipt that has been marked "paid"
  // is expected to have queued exactly one EtimsSubmission for itself (see
  // the post-save hook in models/Receipt.js). A paid receipt with no
  // corresponding EtimsSubmission at all is a gap in the expected flow —
  // e.g. the fire-and-forget queueEtimsSubmission() call failed before it
  // could even create the row. This is read-only detection; nothing here
  // creates the missing submission.
  const receiptIdsWithSubmission = new Set(
    submissions.map((s) => String(s.receiptId?._id || s.receiptId))
  );

  const paidReceipts = await Receipt.find({ businessId, status: "paid" })
    .select("_id billId paidAt")
    .lean();

  for (const receipt of paidReceipts) {
    if (receiptIdsWithSubmission.has(String(receipt._id))) continue;
    needsAttention.push({
      type: "missing-submission",
      submissionId: null,
      receiptId: receipt._id,
      receiptBillId: receipt.billId,
      invoiceNumber: null,
      providerInvoiceNumber: null,
      status: null,
      attempts: null,
      lastError: null,
      processingStartedAt: null,
      submittedAt: null,
      createdAt: null,
      updatedAt: null,
      reasons: ["missing-submission"],
      paidAt: receipt.paidAt,
    });
  }

  return {
    businessId,
    generatedAt: new Date(),
    totalSubmissions: submissions.length,
    counts,
    needsAttentionCount: needsAttention.length,
    needsAttention,
  };
}
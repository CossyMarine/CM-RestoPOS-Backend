// jobs/etimsJob.js
import { agenda, withJobRetry } from "../utils/queue.js";
import EtimsSubmission from "../models/EtimsSubmission.js";
import Business from "../models/Business.js";
import Receipt from "../models/Receipt.js";
import { submitReceiptToEtims } from "../utils/etims.js";

agenda.define(
  "submit-etims",
  withJobRetry(async (job) => {
    const { submissionId } = job.attrs.data;

    const submission = await EtimsSubmission.findOne({ _id: submissionId, _bypassTenantGuard: true });
    if (!submission || submission.status === "submitted") return; // already done, or gone

    const [business, receipt] = await Promise.all([
      Business.findOne({ _id: submission.businessId, _bypassTenantGuard: true }).select("taxPin"),
      Receipt.findOne({ _id: submission.receiptId, businessId: submission.businessId }),
    ]);
    if (!receipt) throw new Error("Receipt no longer exists");

    const result = await submitReceiptToEtims({ receipt, businessTaxPin: business?.taxPin });

    submission.status = "submitted";
    submission.etimsInvoiceNumber = result?.invoiceNumber || null;
    submission.submittedAt = new Date();
    submission.attempts += 1;
    await submission.save();
  }, { maxAttempts: 6, baseDelayMinutes: 2 }) // 2, 4, 8, 16, 32 min backoff, then dead-letter
);

// Called from wherever a receipt is settled — never awaited by the request
// that settles the sale. Creates the tracking row and schedules the job
// "now" (Agenda still processes it async, off the request thread).
export async function queueEtimsSubmission(receipt) {
  try {
    const submission = await EtimsSubmission.findOneAndUpdate(
      { businessId: receipt.businessId, receiptId: receipt._id },
      { $setOnInsert: { status: "queued" } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
await agenda.now("submit-etims", { submissionId: submission._id });
  } catch (error) {
    // Failing to QUEUE the job must never fail the sale itself — log and
    // move on. Worst case, it's caught by manual reconciliation later.
    console.error("Failed to queue eTIMS submission:", error.message);
  }
}
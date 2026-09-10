import { agenda, withJobRetry } from "../utils/queue.js";
import EtimsSubmission from "../models/EtimsSubmission.js";
import Business from "../models/Business.js";
import Receipt from "../models/Receipt.js";
import { submitReceiptToEtims } from "../utils/etims.js";

const MAX_ETIMS_ATTEMPTS = 6;
const STALE_PROCESSING_MS = 5 * 60 * 1000;

agenda.define(
  "submit-etims",
  withJobRetry(
    async (job) => {
      const { submissionId } = job.attrs.data;
      const attempt = (job.attrs.data?._attempts || 0) + 1;
      const staleBefore = new Date(Date.now() - STALE_PROCESSING_MS);

      // Atomically claim this submission. A second Agenda job cannot submit
      // the same receipt while this one is processing it.
      const submission = await EtimsSubmission.findOneAndUpdate(
        {
          _id: submissionId,
          _bypassTenantGuard: true,
          $or: [
            { status: "queued" },
            { status: "failed" },
            {
              status: "processing",
              processingStartedAt: { $lte: staleBefore },
            },
          ],
        },
        {
          $set: {
            status: "processing",
            processingStartedAt: new Date(),
          },
        },
        { new: true }
      );

      // Already submitted, actively being processed, deleted, or otherwise
      // not eligible for this job. Safely do nothing.
      if (!submission) return;

      try {
        const [business, receipt] = await Promise.all([
          Business.findOne({
            _id: submission.businessId,
            _bypassTenantGuard: true,
          }).select("taxPin"),

          Receipt.findOne({
            _id: submission.receiptId,
            businessId: submission.businessId,
            _bypassTenantGuard: true,
          }),
        ]);

        if (!receipt) {
          throw new Error("Receipt no longer exists");
        }

        const result = await submitReceiptToEtims({
          receipt,
          businessTaxPin: business?.taxPin,
        });

        submission.status = "submitted";
        submission.etimsInvoiceNumber = result?.invoiceNumber || null;
        submission.submittedAt = new Date();
        submission.processingStartedAt = null;
        submission.attempts = attempt;
        submission.lastError = null;

        await submission.save();
      } catch (error) {
        submission.attempts = attempt;
        submission.lastError = error.message || "Unknown eTIMS submission error";
        submission.processingStartedAt = null;
        submission.status =
          attempt >= MAX_ETIMS_ATTEMPTS ? "failed-permanent" : "failed";

        await submission.save();

        throw error;
      }
    },
    {
      maxAttempts: MAX_ETIMS_ATTEMPTS,
      baseDelayMinutes: 2,
    }
  )
);

// Creates exactly one durable submission record for a paid receipt, then
// schedules asynchronous processing. Any failure here is intentionally
// isolated from the completed sale.
export async function queueEtimsSubmission(receipt) {
  try {
    const submission = await EtimsSubmission.findOneAndUpdate(
      {
        businessId: receipt.businessId,
        receiptId: receipt._id,
      },
      {
        $setOnInsert: {
          status: "queued",
        },
      },
      {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true,
      }
    );

    if (submission.status === "submitted") return;

    await agenda.now("submit-etims", {
      submissionId: submission._id,
    });
  } catch (error) {
    console.error("Failed to queue eTIMS submission:", error.message);
  }
}
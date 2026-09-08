// utils/queue.js
// Durable, MongoDB-backed background job queue (Agenda). This is what
// separates "the sale is recorded" from "the sale is reported externally" —
// jobs here can fail, retry, and even survive a server restart, without
// ever touching the underlying Order/Receipt.
import Agenda from "agenda";

export const agenda = new Agenda({
  db: { address: process.env.MONGO_URI, collection: "jobs" },
  processEvery: "10 seconds",
  maxConcurrency: 10,
});

export async function startQueue() {
  await agenda.start();
  console.log("🗂️  Job queue started");
}

// Generic retry/backoff wrapper for any job handler. On failure, schedules
// a retry with exponential backoff up to maxAttempts; beyond that, marks
// the job "failed-permanent" (dead-letter) so it stops retrying silently
// forever and instead waits for a human via manual reconciliation.
export function withJobRetry(handler, { maxAttempts = 5, baseDelayMinutes = 1 } = {}) {
  return async (job) => {
    const attempts = (job.attrs.data?._attempts || 0) + 1;
    try {
      await handler(job);
    } catch (error) {
      console.error(`Job ${job.attrs.name} failed (attempt ${attempts}):`, error.message);

      if (attempts >= maxAttempts) {
        job.attrs.data._attempts = attempts;
        job.attrs.data._status = "failed-permanent";
        job.attrs.data._lastError = error.message;
        await job.save();
        return; // stop retrying — needs manual reconciliation now
      }

      job.attrs.data._attempts = attempts;
      job.attrs.data._lastError = error.message;
      const delayMs = baseDelayMinutes * 60 * 1000 * 2 ** (attempts - 1);
      job.schedule(new Date(Date.now() + delayMs));
      await job.save();
    }
  };
}
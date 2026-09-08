// controllers/etimsController.js
import EtimsSubmission from "../models/EtimsSubmission.js";
import { agenda } from "../utils/queue.js";

// @desc    List this business's eTIMS submissions, optionally filtered by status
// @route   GET /api/etims/submissions?status=failed-permanent
export const listEtimsSubmissions = async (req, res) => {
  try {
    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    const submissions = await req.scope(EtimsSubmission).find(filter).sort({ createdAt: -1 }).limit(200);
    res.json({ submissions });
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// @desc    Manually re-trigger a stuck/failed submission
// @route   POST /api/etims/submissions/:id/retry
export const retryEtimsSubmission = async (req, res) => {
  try {
    const submission = await req.scope(EtimsSubmission).findById(req.params.id);
    if (!submission) return res.status(404).json({ message: "Submission not found" });

    submission.status = "queued";
    submission.attempts = 0;
    submission.lastError = null;
    await submission.save();

    await agenda.now("submit-etims", { submissionId: submission._id });
    res.json({ message: "Retry queued", submission });
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
};
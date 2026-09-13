// controllers/etimsController.js
import EtimsSubmission from "../models/EtimsSubmission.js";
import EtimsConfig from "../models/EtimsConfig.js";
import { agenda } from "../utils/queue.js";
import { getProviderAdapter } from "../utils/etimsProviders/index.js";
import { EtimsConfigurationError } from "../utils/etimsErrors.js";
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

    if (!submission) {
      return res.status(404).json({ message: "Submission not found" });
    }

    if (submission.status === "submitted") {
      return res.status(400).json({
        message: "This receipt has already been submitted to eTIMS",
      });
    }

    if (submission.status === "processing") {
      return res.status(409).json({
        message: "This eTIMS submission is already being processed",
      });
    }

    submission.status = "queued";
    submission.attempts = 0;
    submission.lastError = null;
    submission.processingStartedAt = null;

    await submission.save();

    await agenda.now("submit-etims", {
      submissionId: submission._id,
    });

    res.json({
      message: "Retry queued",
      submission,
    });
  } catch (error) {
    res.status(500).json({
      message: "Server error",
      error: error.message,
    });
  }
};
export const getEtimsConfig = async (req, res) => {
  try {
    const config =
      (await req.scope(EtimsConfig).findOne({ enabled: true })) ||
      (await req.scope(EtimsConfig).findOne().sort({ updatedAt: -1 }));

    if (!config) {
      return res.json({ config: null, message: "No eTIMS configuration on file yet" });
    }
    res.json({ config });
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
};
export const setEtimsConfig = async (req, res) => {
  try {
    const { provider, deviceInfo, credentials, environment, enabled, status, statusMessage } = req.body;

    if (!provider || typeof provider !== "string") {
      return res.status(400).json({ message: "provider is required" });
    }

    // Reject anything the provider registry doesn't actually support —
    // never persist a configuration that can never submit anything.
    try {
      getProviderAdapter(provider.trim().toLowerCase());
    } catch (err) {
      if (err instanceof EtimsConfigurationError) {
        return res.status(400).json({ message: err.message });
      }
      throw err;
    }

    if (environment && !["sandbox", "production"].includes(environment)) {
      return res.status(400).json({ message: "environment must be 'sandbox' or 'production'" });
    }

    const config = await EtimsConfig.upsertForBusiness(req.businessId, provider, {
      deviceInfo,
      credentials,
      environment,
      enabled,
      status,
      statusMessage,
    });

    res.json({ message: "eTIMS configuration saved", config });
  } catch (error) {
    // Only one config may be enabled per business (partial unique index on
    // { businessId, enabled: true }) — surface the DB's own guarantee as a
    // clean 409 instead of a raw duplicate-key 500.
    if (error.code === 11000) {
      return res.status(409).json({
        message:
          "Another eTIMS provider configuration is already enabled for this business. Disable it before enabling this one.",
      });
    }
    if (error.name === "ValidationError") {
      return res.status(400).json({ message: error.message });
    }
    res.status(500).json({ message: "Server error", error: error.message });
  }
};
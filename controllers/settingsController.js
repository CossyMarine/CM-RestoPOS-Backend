// controllers/settingsController.js
import AdminSettings from "../models/AdminSettings.js";

// @desc    Get full admin settings
// @route   GET /api/settings
// @access  Protected — admin
export const getSettings = async (req, res) => {
  try {
    const settings = await AdminSettings.getSettings();
    res.json(settings);
  } catch (error) {
    console.error("Error fetching settings:", error.message);
    res.status(500).json({ message: "Failed to fetch settings" });
  }
};

// @desc    Update admin settings (partial merge — send only what changed)
// @route   PATCH /api/settings
// @access  Protected — admin
export const updateSettings = async (req, res) => {
  const { tillNumber, tillName, whatsappNumber, callNumber, reward } = req.body;

  try {
    const settings = await AdminSettings.getSettings();

    if (tillNumber !== undefined) settings.tillNumber = tillNumber;
    if (tillName !== undefined) settings.tillName = tillName;
    if (whatsappNumber !== undefined) settings.whatsappNumber = whatsappNumber;
    if (callNumber !== undefined) settings.callNumber = callNumber;

    if (reward && typeof reward === "object") {
      const current = settings.reward.toObject ? settings.reward.toObject() : settings.reward;
      settings.reward = { ...current, ...reward };
    }

    await settings.save();
    res.json(settings);
  } catch (error) {
    console.error("Error updating settings:", error.message);
    res.status(500).json({ message: "Failed to update settings", error: error.message });
  }
};

// @desc    Public settings needed by the customer app — WhatsApp/call numbers,
//          till number for manual payment, and reward program description
// @route   GET /api/settings/public
// @access  Public
export const getPublicSettings = async (req, res) => {
  try {
    const s = await AdminSettings.getSettings();
    res.json({
      tillNumber: s.tillNumber,
      tillName: s.tillName,
      whatsappNumber: s.whatsappNumber,
      callNumber: s.callNumber,
      reward: {
        enabled: s.reward.enabled,
        pointValueKes: s.reward.pointValueKes,
        targetPoints: s.reward.targetPoints,
        description: s.reward.description,
      },
    });
  } catch (error) {
    console.error("Error fetching public settings:", error.message);
    res.status(500).json({ message: "Failed to fetch settings" });
  }
};

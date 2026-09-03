// controllers/kitchenSettingsController.js
import KitchenSettings from "../models/KitchenSettings.js";
import NotificationSound from "../models/NotificationSound.js";

// @desc    Get kitchen display settings
// @route   GET /api/kitchen-settings
// @access  Protected — kitchen, admin
export const getKitchenSettings = async (req, res) => {
  try {
    const settings = await KitchenSettings.getSettings(req.businessId);
    res.json(settings);
  } catch (error) {
    console.error("Error fetching kitchen settings:", error.message);
    res.status(500).json({ message: "Failed to fetch kitchen settings" });
  }
};

// @desc    Update kitchen display settings (partial merge — send only what changed)
// @route   PATCH /api/kitchen-settings
// @access  Protected — admin
export const updateKitchenSettings = async (req, res) => {
  const {
    sortOrder,
    requireClickToServe,
    cardSize,
    soundEnabled,
    lateThresholdMinutes,
    criticalThresholdMinutes,
    notificationSoundId, // string id from the library, or null/"" to clear
  } = req.body;

  const { businessId } = req;

  try {
    const settings = await KitchenSettings.getSettings(businessId);
    if (sortOrder !== undefined) settings.sortOrder = sortOrder;
    if (requireClickToServe !== undefined) settings.requireClickToServe = requireClickToServe;
    if (cardSize !== undefined) settings.cardSize = cardSize;
    if (soundEnabled !== undefined) settings.soundEnabled = soundEnabled;
    if (lateThresholdMinutes !== undefined) settings.lateThresholdMinutes = lateThresholdMinutes;
    if (criticalThresholdMinutes !== undefined) settings.criticalThresholdMinutes = criticalThresholdMinutes;

    if (notificationSoundId !== undefined) {
      if (!notificationSoundId) {
        settings.notificationSoundId = null;
        settings.notificationSoundUrl = null;
        settings.notificationSoundName = null;
      } else {
        const sound = await NotificationSound.findOne({ _id: notificationSoundId, businessId });
        if (!sound) {
          return res.status(404).json({ message: "Notification sound not found" });
        }
        settings.notificationSoundId = sound._id;
        settings.notificationSoundUrl = sound.url;
        settings.notificationSoundName = sound.name;
      }
    }

    await settings.save();

    const io = req.app.get("io");
    io.emit("kitchen:settings_updated", settings);

    res.json(settings);
  } catch (error) {
    console.error("Error updating kitchen settings:", error.message);
    res.status(500).json({ message: "Failed to update kitchen settings", error: error.message });
  }
};
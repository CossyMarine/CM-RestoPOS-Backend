// controllers/notificationSoundController.js
import NotificationSound from "../models/NotificationSound.js";
import KitchenSettings from "../models/KitchenSettings.js";
import { cloudinary } from "../Config/cloudinary.js";

// @desc    List uploaded notification sounds
// @route   GET /api/notification-sounds
// @access  Protected — kitchen, admin
export const getNotificationSounds = async (req, res) => {
  try {
    const sounds = await NotificationSound.find().sort({ name: 1 });
    res.json(sounds);
  } catch (error) {
    console.error("Error fetching notification sounds:", error.message);
    res.status(500).json({ message: "Failed to fetch notification sounds" });
  }
};

// @desc    Upload a notification sound from device
// @route   POST /api/notification-sounds
// @access  Protected — admin
export const uploadNotificationSound = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "No audio file uploaded" });
    }

    const { name } = req.body;
    if (!name || !name.trim()) {
      await cloudinary.uploader.destroy(req.file.filename, { resource_type: "video" }).catch(() => {});
      return res.status(400).json({ message: "A name is required for the sound" });
    }

    const sound = await NotificationSound.create({
      name: name.trim(),
      url: req.file.path,       // Cloudinary secure URL
      publicId: req.file.filename,
    });

    res.status(201).json(sound);
  } catch (error) {
    console.error("Error uploading notification sound:", error.message);
    res.status(500).json({ message: "Failed to upload notification sound" });
  }
};

// @desc    Delete a notification sound
// @route   DELETE /api/notification-sounds/:id
// @access  Protected — admin
export const deleteNotificationSound = async (req, res) => {
  try {
    const sound = await NotificationSound.findById(req.params.id);
    if (!sound) {
      return res.status(404).json({ message: "Sound not found" });
    }

    await cloudinary.uploader.destroy(sound.publicId, { resource_type: "video" }).catch(() => {});
    await sound.deleteOne();

    // If this was the active kitchen alarm, fall back to the built-in beep
    // rather than leaving the kitchen page pointing at a dead URL.
    const settings = await KitchenSettings.getSettings();
    if (settings.notificationSoundId?.toString() === req.params.id) {
      settings.notificationSoundId = null;
      settings.notificationSoundUrl = null;
      settings.notificationSoundName = null;
      await settings.save();

      const io = req.app.get("io");
      io.emit("kitchen:settings_updated", settings);
    }

    res.json({ message: "Notification sound deleted" });
  } catch (error) {
    console.error("Error deleting notification sound:", error.message);
    res.status(500).json({ message: "Failed to delete notification sound" });
  }
};

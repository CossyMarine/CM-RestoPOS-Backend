// models/KitchenSettings.js
import mongoose from "mongoose";

const kitchenSettingsSchema = new mongoose.Schema(
  {
    // Singleton lock — only one document ever exists
    key: { type: String, default: "global", unique: true },

    // "oldest" = new tickets join the bottom of the queue (FIFO). "newest" = new tickets jump to the top.
    sortOrder: { type: String, enum: ["oldest", "newest"], default: "oldest" },

    // true (default): cook must tap "Serve Order" to clear a ticket.
    // false: ticket auto-clears the instant every item on it is checked ready.
    requireClickToServe: { type: Boolean, default: true },

    // Controls card grid density on the kitchen display
    cardSize: { type: String, enum: ["small", "medium", "large"], default: "medium" },

    soundEnabled: { type: Boolean, default: true },

    // Custom alarm sound picked from the uploaded library. Null = fall back
    // to the built-in generated beep. url/name are denormalized here so the
    // kitchen display gets everything it needs in a single settings fetch.
    notificationSoundId: { type: mongoose.Schema.Types.ObjectId, ref: "NotificationSound", default: null },
    notificationSoundUrl: { type: String, default: null },
    notificationSoundName: { type: String, default: null },

    // Minutes before a ticket turns yellow ("late") / red ("critical")
    lateThresholdMinutes: { type: Number, default: 8 },
    criticalThresholdMinutes: { type: Number, default: 15 },
  },
  { timestamps: true }
);

kitchenSettingsSchema.statics.getSettings = async function () {
  let settings = await this.findOne({ key: "global" });
  if (!settings) settings = await this.create({ key: "global" });
  return settings;
};

export default mongoose.model("KitchenSettings", kitchenSettingsSchema);

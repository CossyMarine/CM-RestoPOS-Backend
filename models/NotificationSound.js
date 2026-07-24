// models/NotificationSound.js
import mongoose from "mongoose";

const notificationSoundSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    url: { type: String, required: true },       // Cloudinary secure URL
    publicId: { type: String, required: true },   // Cloudinary public_id (for deletion)
  },
  { timestamps: true }
);

export default mongoose.model("NotificationSound", notificationSoundSchema);

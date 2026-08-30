// models/NotificationSound.js
import mongoose from "mongoose";
import tenantGuard from "../Middlewares/plugins/tenantGuard.js";

const notificationSoundSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    url: { type: String, required: true },       // Cloudinary secure URL
    publicId: { type: String, required: true },   // Cloudinary public_id (for deletion)
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Business",
      required: true,
      index: true,
    },
  },
  { timestamps: true }
);
notificationSoundSchema.plugin(tenantGuard);

export default mongoose.model("NotificationSound", notificationSoundSchema);

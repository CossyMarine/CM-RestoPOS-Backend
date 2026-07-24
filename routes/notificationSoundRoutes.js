// routes/notificationSoundRoutes.js
import express from "express";
import { protect, authorize } from "../Middlewares/authMiddleware.js";
import {
  getNotificationSounds,
  uploadNotificationSound,
  deleteNotificationSound,
} from "../controllers/notificationSoundController.js";
import { uploadNotificationSound as uploadNotificationSoundMiddleware } from "../Config/cloudinary.js";

const router = express.Router();

router.get("/", protect, authorize("kitchen", "admin"), getNotificationSounds);

router.post(
  "/",
  protect,
  authorize("admin"),
  uploadNotificationSoundMiddleware.single("sound"),
  uploadNotificationSound
);

router.delete("/:id", protect, authorize("admin"), deleteNotificationSound);

export default router;

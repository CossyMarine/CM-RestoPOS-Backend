// routes/menuRoutes.js
import express from "express";
import {
  getMenu,
  createMenuItem,
  updateMenuItem,
  deleteMenuItem,
  uploadMenuImage,
} from "../controllers/menuController.js";
import { protect, authorize } from "../Middlewares/authMiddleware.js";
import { uploadMenuImage as uploadMenuImageMiddleware } from "../config/cloudinary.js";

const router = express.Router();

const staffRoles = authorize("admin", "manager", "waiter", "accountant");

router.get("/", getMenu);

router.post(
  "/upload-image",
  protect,
  staffRoles,
  uploadMenuImageMiddleware.single("image"),
  uploadMenuImage
);

router.post("/", protect, staffRoles, createMenuItem);
router.put("/:id", protect, staffRoles, updateMenuItem);
router.delete("/:id", protect, staffRoles, deleteMenuItem);

export default router;

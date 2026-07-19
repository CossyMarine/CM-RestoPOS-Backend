// routes/menuRoutes.js
import express from "express";
import {
  getMenu,
  createMenuItem,
  updateMenuItem,
  deleteMenuItem,
  uploadMenuImage,
  togglePinMenuItem,
  reorderPinnedMenu,
} from "../controllers/menuController.js";
import { protect, authorize } from "../Middlewares/authMiddleware.js";
import { uploadMenuImage as uploadMenuImageMiddleware } from "../Config/cloudinary.js";

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

// Literal routes before "/:id" so Express doesn't treat "reorder-pinned" as an id
router.put("/reorder-pinned", protect, staffRoles, reorderPinnedMenu);
router.patch("/:id/pin", protect, staffRoles, togglePinMenuItem);

router.post("/", protect, staffRoles, createMenuItem);
router.put("/:id", protect, staffRoles, updateMenuItem);
router.delete("/:id", protect, staffRoles, deleteMenuItem);

export default router;

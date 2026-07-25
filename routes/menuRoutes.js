// routes/menuRoutes.js
import express from "express";
import {
  getMenu, createMenuItem, updateMenuItem, deleteMenuItem,
  uploadMenuImage, togglePinMenuItem, reorderPinnedMenu,
} from "../controllers/menuController.js";
import { protect, authorize, requirePermission } from "../Middlewares/authMiddleware.js";
import { uploadMenuImage as uploadMenuImageMiddleware } from "../Config/cloudinary.js";

const router = express.Router();

const staffRoles = authorize("admin", "manager", "waiter", "accountant");
const menuGate = requirePermission("manageMenu"); // was open to any accountant before — now gated

router.get("/", getMenu);

router.post("/upload-image", protect, staffRoles, menuGate, uploadMenuImageMiddleware.single("image"), uploadMenuImage);
router.put("/reorder-pinned", protect, staffRoles, menuGate, reorderPinnedMenu);
router.patch("/:id/pin", protect, staffRoles, menuGate, togglePinMenuItem);
router.post("/", protect, staffRoles, menuGate, createMenuItem);
router.put("/:id", protect, staffRoles, menuGate, updateMenuItem);
router.delete("/:id", protect, staffRoles, menuGate, deleteMenuItem);

export default router;

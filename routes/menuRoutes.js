// routes/menuRoutes.js
import express from "express";
import {
  getMenu,
  createMenuItem,
  updateMenuItem,
  deleteMenuItem,
} from "../controllers/menuController.js";
import { protect, authorize } from "../Middlewares/authMiddleware.js";

const router = express.Router();

router.get("/", getMenu);
router.post("/", protect, authorize("admin", "manager", "waiter", "accountant"), createMenuItem);
router.put("/:id", protect, authorize("admin", "manager", "waiter", "accountant"), updateMenuItem);
router.delete("/:id", protect, authorize("admin", "manager", "waiter", "accountant"), deleteMenuItem);

export default router;

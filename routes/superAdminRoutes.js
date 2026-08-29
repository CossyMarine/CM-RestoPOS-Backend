import express from "express";
import { protect, requireSuperAdmin } from "../Middlewares/authMiddleware.js";
import {
  createBusiness,
  listBusinesses,
  toggleBusinessStatus,
  createBusinessAdmin,
  getPlatformOverview,
} from "../controllers/superAdminController.js";

const router = express.Router();

router.use(protect, requireSuperAdmin); // every route below is superadmin-only

router.get("/overview", getPlatformOverview);
router.get("/businesses", listBusinesses);
router.post("/businesses", createBusiness);
router.patch("/businesses/:id/status", toggleBusinessStatus);
router.post("/businesses/:id/admin", createBusinessAdmin);

export default router;
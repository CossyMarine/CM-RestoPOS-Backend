// AFTER
import express from "express";
import { protect, requireSuperAdmin } from "../Middlewares/authMiddleware.js";
import {
  createBusiness,
  listBusinesses,
  toggleBusinessStatus,getBusinessEtimsConfig,getBusinessPaymentConfig, configureBusinessPaymentConfig,
  createBusinessAdmin,configureBusinessEtims,
  configureBusinessSettings,
  getPlatformOverview,
  getBusinessEtimsReconciliation,
} from "../controllers/superAdminController.js";

const router = express.Router();

router.use(protect, requireSuperAdmin); // every route below is superadmin-only

router.get("/overview", getPlatformOverview);
router.get("/businesses", listBusinesses);
router.post("/businesses", createBusiness);
router.patch("/businesses/:id/status", toggleBusinessStatus);
router.post("/businesses/:id/admin", createBusinessAdmin);
router.patch("/businesses/:id/settings", configureBusinessSettings);
router.patch("/businesses/:id/etims-config", configureBusinessEtims);
router.get("/businesses/:id/etims-reconciliation", getBusinessEtimsReconciliation);
router.get("/businesses/:id/payment-config", getBusinessPaymentConfig);
router.patch("/businesses/:id/payment-config", configureBusinessPaymentConfig);
router.get("/businesses/:id/etims-config", getBusinessEtimsConfig);
export default router;
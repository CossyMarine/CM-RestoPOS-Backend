// routes/walletRoutes.js
import express from "express";
import { protect, authorize, requirePermission, requireOpenShift } from "../Middlewares/authMiddleware.js";
import {
  getMyWallet,
  resolveBill,
  payWithManualTill,
  payWithStk,
  getWalletStkStatus,
  payWithReward,
  adminAddReward,
  adminPayWithReward,
} from "../controllers/walletController.js";

const router = express.Router();

router.get("/me", protect, getMyWallet);
router.post("/resolve-bill", protect, resolveBill);
router.post("/pay/manual", protect, payWithManualTill);
router.post("/pay/stk", protect, payWithStk);
router.get("/pay/stk/:receiptId/status", protect, getWalletStkStatus);
router.post("/pay/reward", protect, payWithReward);

router.post("/admin/add-reward", protect, authorize("admin", "accountant"), requirePermission("payments"), adminAddReward);
router.post("/admin/pay-with-reward", protect, authorize("admin", "accountant"), requirePermission("payments"), requireOpenShift, adminPayWithReward);

export default router;

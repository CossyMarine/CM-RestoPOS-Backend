// routes/receiptRoutes.js
import express from "express";
import {
  payReceipt,
  getReceipts,
  getPaidReceipts,
  getReceiptsByWaiter,
} from "../controllers/receiptController.js";
import { protect, authorize } from "../Middlewares/authMiddleware.js";

const router = express.Router();

router.patch("/:id/pay", protect, authorize("admin"), payReceipt);
router.get("/", protect, authorize("admin"), getReceipts);
router.get("/paid", protect, authorize("admin", "accountant"), getPaidReceipts);
router.get("/waiter/:name", protect, getReceiptsByWaiter);

export default router;

// scripts/verifyBackfill.js — run after backfillBusinessId.js
// node scripts/verifyBackfill.js

import "dotenv/config";
import mongoose from "mongoose";

import User from "../models/User.js";
import Order from "../models/Order.js";
import Receipt from "../models/Receipt.js";
import Shift from "../models/Shift.js";
import MenuItem from "../models/MenuItem.js";
import VoidRequest from "../models/VoidRequest.js";
import PettyCash from "../models/PettyCash.js";
import InventoryItem from "../models/InventoryItem.js";
import InventoryStock from "../models/InventoryStock.js";
import InventoryBatch from "../models/InventoryBatch.js";
import InventoryLocation from "../models/InventoryLocation.js";
import InventoryReceiving from "../models/InventoryReceiving.js";
import InventoryUnit from "../models/InventoryUnit.js";
import InventoryUsageLog from "../models/InventoryUsageLog.js";
import InventoryWaste from "../models/InventoryWaste.js";
import InventoryTransfer from "../models/InventoryTransfer.js";
import StockEntry from "../models/StockEntry.js";
import Production from "../models/Production.js";
import PurchaseOrder from "../models/PurchaseOrder.js";
import Recipe from "../models/Recipe.js";
import Supplier from "../models/Supplier.js";
import NotificationSound from "../models/NotificationSound.js";
import Counter from "../models/Counter.js";
import AdminSettings from "../models/AdminSettings.js";
import KitchenSettings from "../models/KitchenSettings.js";
import RewardTransaction from "../models/RewardTransaction.js";

const allModels = [
  User, Order, Receipt, Shift, MenuItem, VoidRequest, PettyCash,
  InventoryItem, InventoryStock, InventoryBatch, InventoryLocation,
  InventoryReceiving, InventoryUnit, InventoryUsageLog, InventoryWaste,
  InventoryTransfer, StockEntry, Production, PurchaseOrder, Recipe,
  Supplier, NotificationSound, Counter, AdminSettings, KitchenSettings,
  RewardTransaction,
];

const run = async () => {
  await mongoose.connect(process.env.MONGO_URI);
  console.log("Connected.\n");

  let anyFailure = false;

  console.log("=== Step 1: Missing businessId check ===");
  for (const Model of allModels) {
    const filter = { businessId: { $exists: false }, _bypassTenantGuard: true };
    if (Model.modelName === "User") filter.role = { $ne: "superadmin" };

    const missing = await Model.countDocuments(filter);
    const total = await Model.countDocuments({ _bypassTenantGuard: true });
    const status = missing === 0 ? "OK" : "FAIL";
    if (missing !== 0) anyFailure = true;
    console.log(`${status}  ${Model.modelName}: ${missing} missing / ${total} total`);
  }

  console.log("\n=== Step 2: Cross-reference integrity ===");

  const receipts = await Receipt.find({ _bypassTenantGuard: true }).select("businessId order").lean();
  let receiptMismatches = 0;
  for (const r of receipts) {
    if (!r.order) continue;
    const order = await Order.findOne({ _id: r.order, _bypassTenantGuard: true }).select("businessId").lean();
    if (order && String(order.businessId) !== String(r.businessId)) {
      receiptMismatches++;
      console.log(`  MISMATCH: Receipt ${r._id} businessId=${r.businessId} but its Order ${r.order} businessId=${order.businessId}`);
    }
  }
  console.log(`${receiptMismatches === 0 ? "OK" : "FAIL"}  Receipt -> Order businessId match: ${receiptMismatches} mismatch(es) out of ${receipts.length} receipts`);
  if (receiptMismatches > 0) anyFailure = true;

  const stocks = await InventoryStock.find({ _bypassTenantGuard: true }).select("businessId item").lean();
  let stockMismatches = 0;
  for (const s of stocks) {
    const item = await InventoryItem.findOne({ _id: s.item, _bypassTenantGuard: true }).select("businessId").lean();
    if (item && String(item.businessId) !== String(s.businessId)) {
      stockMismatches++;
      console.log(`  MISMATCH: InventoryStock ${s._id} businessId=${s.businessId} but its InventoryItem ${s.item} businessId=${item.businessId}`);
    }
  }
  console.log(`${stockMismatches === 0 ? "OK" : "FAIL"}  InventoryStock -> InventoryItem businessId match: ${stockMismatches} mismatch(es) out of ${stocks.length} stock records`);
  if (stockMismatches > 0) anyFailure = true;

  const recipes = await Recipe.find({ _bypassTenantGuard: true }).select("businessId menuItem").lean();
  let recipeMismatches = 0;
  for (const r of recipes) {
    const menuItem = await MenuItem.findOne({ _id: r.menuItem, _bypassTenantGuard: true }).select("businessId").lean();
    if (menuItem && String(menuItem.businessId) !== String(r.businessId)) {
      recipeMismatches++;
      console.log(`  MISMATCH: Recipe ${r._id} businessId=${r.businessId} but its MenuItem ${r.menuItem} businessId=${menuItem.businessId}`);
    }
  }
  console.log(`${recipeMismatches === 0 ? "OK" : "FAIL"}  Recipe -> MenuItem businessId match: ${recipeMismatches} mismatch(es) out of ${recipes.length} recipes`);
  if (recipeMismatches > 0) anyFailure = true;

  console.log(`\n${anyFailure ? "FAILED — do not proceed to run the application until every FAIL above is resolved." : "ALL CHECKS PASSED — safe to start the application."}`);

  await mongoose.disconnect();
  process.exit(anyFailure ? 1 : 0);
};

run().catch((err) => {
  console.error("Verification failed to run:", err.message);
  process.exit(1);
});
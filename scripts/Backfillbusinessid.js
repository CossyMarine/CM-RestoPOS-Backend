// scripts/backfillBusinessId.js
// Run a DRY RUN first: node scripts/backfillBusinessId.js --dry-run
// Then for real:        node scripts/backfillBusinessId.js
//
// Requires DEFAULT_BUSINESS_ID in your env, pointing at the Business
// document created by createInitialBusiness.js.

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

// User is handled separately below (superadmin accounts must be skipped —
// they legitimately have no businessId). Every other model here is
// unconditionally stamped.
const models = [
  Order, Receipt, Shift, MenuItem, VoidRequest, PettyCash,
  InventoryItem, InventoryStock, InventoryBatch, InventoryLocation,
  InventoryReceiving, InventoryUnit, InventoryUsageLog, InventoryWaste,
  InventoryTransfer, StockEntry, Production, PurchaseOrder, Recipe,
  Supplier, NotificationSound, Counter, AdminSettings, KitchenSettings,
  RewardTransaction,
];

const isDryRun = process.argv.includes("--dry-run");

const run = async () => {
  const businessId = process.env.DEFAULT_BUSINESS_ID;
  if (!businessId || !mongoose.Types.ObjectId.isValid(businessId)) {
    console.error("Set a valid DEFAULT_BUSINESS_ID in your env before running this.");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);
  console.log(`Connected. ${isDryRun ? "DRY RUN — no writes will be made." : "LIVE RUN — writes will be made."}`);
  console.log(`Target businessId: ${businessId}\n`);

  const summary = [];

  // --- Every model except User ---
  for (const Model of models) {
    const filter = { businessId: { $exists: false } };
    const matching = await Model.countDocuments(filter);

    if (isDryRun) {
      summary.push({ model: Model.modelName, wouldUpdate: matching });
      console.log(`[DRY RUN] ${Model.modelName}: ${matching} document(s) would be updated`);
    } else {
      const { modifiedCount } = await Model.updateMany(filter, { $set: { businessId } });
      summary.push({ model: Model.modelName, updated: modifiedCount });
      console.log(`${Model.modelName}: updated ${modifiedCount}`);
    }
  }

  // --- User: skip anyone already flagged as superadmin ---
  const userFilter = { businessId: { $exists: false }, role: { $ne: "superadmin" } };
  const matchingUsers = await User.countDocuments(userFilter);

  if (isDryRun) {
    summary.push({ model: "User", wouldUpdate: matchingUsers });
    console.log(`[DRY RUN] User: ${matchingUsers} document(s) would be updated (superadmins excluded)`);
  } else {
    const { modifiedCount } = await User.updateMany(userFilter, { $set: { businessId } });
    summary.push({ model: "User", updated: modifiedCount });
    console.log(`User: updated ${modifiedCount} (superadmins excluded)`);
  }

  console.log("\n--- Summary ---");
  console.table(summary);

  if (isDryRun) {
    console.log("\nDry run complete. Re-run without --dry-run to apply these changes.");
  } else {
    console.log("\nBackfill complete. Run scripts/verifyBackfill.js next.");
  }

  await mongoose.disconnect();
  process.exit(0);
};

run().catch((err) => {
  console.error("Backfill failed:", err.message);
  process.exit(1);
});
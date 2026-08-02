import dotenv from "dotenv";
import mongoose from "mongoose";
import InventoryStock from "../models/InventoryStock.js";
import InventoryBatch from "../models/InventoryBatch.js";

dotenv.config();

// Run once against a backup-tested database before enabling transfers of the
// same lot between locations. It never guesses when batch quantities exceed
// aggregate stock; those rows are reported for manual reconciliation.
const run = async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const stocks = await InventoryStock.find();
  const conflicts = [];

  for (const stock of stocks) {
    const [total] = await InventoryBatch.aggregate([
      { $match: { inventoryItem: stock.item, location: stock.location, status: { $ne: "cancelled" } } },
      { $group: { _id: null, quantity: { $sum: "$quantity" } } },
    ]);
    const unbatchedQuantity = Number(stock.quantity) - Number(total?.quantity || 0);
    if (unbatchedQuantity < -0.000001) {
      conflicts.push({ stockId: stock._id, item: stock.item, location: stock.location, quantity: stock.quantity, batchQuantity: total?.quantity || 0 });
      continue;
    }
    stock.unbatchedQuantity = Math.max(0, unbatchedQuantity);
    await stock.save();
  }

  if (conflicts.length) {
    console.error("Batch migration stopped: aggregate stock is lower than tracked batch stock.");
    console.error(JSON.stringify(conflicts, null, 2));
    process.exitCode = 1;
  } else {
    const indexes = await InventoryBatch.collection.indexes();
    if (indexes.some((index) => index.name === "batchNumber_1_inventoryItem_1")) {
      await InventoryBatch.collection.dropIndex("batchNumber_1_inventoryItem_1");
    }
    await InventoryBatch.syncIndexes();
    console.log(`Reconciled ${stocks.length} location stock records.`);
  }

  await mongoose.disconnect();
};

run().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect();
  process.exit(1);
});

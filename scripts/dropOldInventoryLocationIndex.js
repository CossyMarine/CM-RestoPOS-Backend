// scripts/dropOldInventoryLocationIndex.js — run ONCE
import "dotenv/config";
import mongoose from "mongoose";
import InventoryLocation from "../models/InventoryLocation.js";

const run = async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const indexes = await InventoryLocation.collection.indexes();
  console.log("Current indexes:", indexes.map((i) => i.name));

  for (const name of ["name_1", "code_1"]) {
    if (indexes.some((i) => i.name === name)) {
      await InventoryLocation.collection.dropIndex(name);
      console.log(`Dropped index: ${name}`);
    } else {
      console.log(`Index not found (already gone): ${name}`);
    }
  }

  await InventoryLocation.syncIndexes();
  console.log("Synced indexes:", (await InventoryLocation.collection.indexes()).map((i) => i.name));

  await mongoose.disconnect();
  process.exit(0);
};

run().catch((err) => {
  console.error("Failed:", err.message);
  process.exit(1);
});
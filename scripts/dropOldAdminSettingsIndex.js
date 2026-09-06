// scripts/dropOldAdminSettingsIndex.js — run ONCE
import "dotenv/config";
import mongoose from "mongoose";
import AdminSettings from "../models/AdminSettings.js";

const run = async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const indexes = await AdminSettings.collection.indexes();
  console.log("Current indexes:", indexes.map((i) => i.name));

  if (indexes.some((i) => i.name === "key_1")) {
    await AdminSettings.collection.dropIndex("key_1");
    console.log("Dropped index: key_1");
  } else {
    console.log("Index not found (already gone): key_1");
  }

  await AdminSettings.syncIndexes();
  console.log("Synced indexes:", (await AdminSettings.collection.indexes()).map((i) => i.name));

  await mongoose.disconnect();
  process.exit(0);
};

run().catch((err) => {
  console.error("Failed:", err.message);
  process.exit(1);
});
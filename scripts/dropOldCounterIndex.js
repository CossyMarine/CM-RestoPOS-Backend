// scripts/dropOldCounterIndex.js — run ONCE
import "dotenv/config";
import mongoose from "mongoose";
import Counter from "../models/Counter.js";

const run = async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const indexes = await Counter.collection.indexes();
  console.log("Current indexes:", indexes.map((i) => i.name));

  if (indexes.some((i) => i.name === "name_1")) {
    await Counter.collection.dropIndex("name_1");
    console.log("Dropped index: name_1");
  } else {
    console.log("Index not found (already gone): name_1");
  }

  await Counter.syncIndexes();
  console.log("Synced indexes:", (await Counter.collection.indexes()).map((i) => i.name));

  await mongoose.disconnect();
  process.exit(0);
};

run().catch((err) => {
  console.error("Failed:", err.message);
  process.exit(1);
});
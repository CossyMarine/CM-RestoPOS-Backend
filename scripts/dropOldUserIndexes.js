// scripts/dropOldUserIndexes.js — run ONCE, after deploying the User.js schema change
import "dotenv/config";
import mongoose from "mongoose";
import User from "../models/User.js";

const run = async () => {
  await mongoose.connect(process.env.MONGO_URI);
  console.log("Connected.");

  const indexes = await User.collection.indexes();
  console.log("Current indexes:", indexes.map((i) => i.name));

  for (const name of ["email_1", "phone_1"]) {
    const exists = indexes.some((i) => i.name === name);
    if (exists) {
      await User.collection.dropIndex(name);
      console.log(`Dropped index: ${name}`);
    } else {
      console.log(`Index not found (already gone): ${name}`);
    }
  }

  // Make sure the new compound indexes exist (Mongoose creates these
  // automatically on next app startup too, but this makes it happen now)
  await User.syncIndexes();
  console.log("Synced indexes:", (await User.collection.indexes()).map((i) => i.name));

  await mongoose.disconnect();
  process.exit(0);
};

run().catch((err) => {
  console.error("Failed:", err.message);
  process.exit(1);
});
// scripts/checkBusinesses.js
import "dotenv/config";
import mongoose from "mongoose";
import Business from "../models/Business.js";

const run = async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const businesses = await Business.find({});
  console.log(JSON.stringify(businesses, null, 2));
  await mongoose.disconnect();
  process.exit(0);
};
run();
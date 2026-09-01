// scripts/checkEmailFieldType.js
import "dotenv/config";
import mongoose from "mongoose";
import User from "../models/User.js";

const run = async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const results = await User.aggregate([
    { $project: { fullName: 1, emailType: { $type: "$email" } } },
    { $group: { _id: "$emailType", count: { $sum: 1 } } },
  ]);
  console.log(results);
  await mongoose.disconnect();
  process.exit(0);
};

run().catch((err) => { console.error(err.message); process.exit(1); });
// scripts/cleanupTestEtimsJob.js
import "dotenv/config";
import mongoose from "mongoose";
import EtimsSubmission from "../models/EtimsSubmission.js";

const run = async () => {
  await mongoose.connect(process.env.MONGO_URI);
  await mongoose.connection.db.collection("jobs").deleteOne({ _id: new mongoose.Types.ObjectId("6aa04b4ac3f6e47b8393d00c") });
  await EtimsSubmission.deleteOne({ _id: "6aa042a15d376a2824145a45", _bypassTenantGuard: true });
  console.log("Cleaned up test job/submission");
  await mongoose.disconnect();
  process.exit(0);
};
run();
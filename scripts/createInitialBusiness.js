// scripts/createInitialBusiness.js — run ONCE: node scripts/createInitialBusiness.js
import "dotenv/config";
import mongoose from "mongoose";
import Business from "../models/Business.js";

const run = async () => {
  await mongoose.connect(process.env.MONGO_URI);

  const existing = await Business.findOne({});
  if (existing) {
    console.log("Business already exists:", existing._id.toString());
    process.exit(0);
  }

  const business = await Business.create({
    name: "REPLACE_WITH_ACTUAL_BUSINESS_NAME",
    phone: "REPLACE",
    email: "REPLACE",
    kraPin: "REPLACE_OR_OMIT",
    status: "active",
    plan: "pro",
    subscriptionStatus: "active",
    subscriptionStart: new Date(),
  });

  console.log("Created Business:", business._id.toString());
  console.log("Save this ID — you'll need it to backfill businessId on every other collection in the next sub-phase.");
  process.exit(0);
};

run();
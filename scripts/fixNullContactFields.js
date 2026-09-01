// scripts/findNullContacts.js
import "dotenv/config";
import mongoose from "mongoose";
import User from "../models/User.js";

const run = async () => {
  await mongoose.connect(process.env.MONGO_URI);

  const nullEmails = await User.find({ email: null, _bypassTenantGuard: true }).select("_id fullName email phone role createdAt");
  console.log(`${nullEmails.length} user(s) with email === null:`);
  console.log(nullEmails);

  const nullPhones = await User.find({ phone: null, _bypassTenantGuard: true }).select("_id fullName email phone role createdAt");
  console.log(`\n${nullPhones.length} user(s) with phone === null:`);
  console.log(nullPhones);

  await mongoose.disconnect();
  process.exit(0);
};

run().catch((err) => {
  console.error("Failed:", err.message);
  process.exit(1);
});
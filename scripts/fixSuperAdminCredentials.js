// scripts/fixSuperAdminCredentials.js — run ONCE
import "dotenv/config";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import User from "../models/User.js";

const run = async () => {
  await mongoose.connect(process.env.MONGO_URI);

  const superadmin = await User.findOne({ role: "superadmin", _bypassTenantGuard: true });
  if (!superadmin) {
    console.log("No superadmin found — nothing to fix.");
    process.exit(0);
  }

  const newEmail = "ckibe105@gmail.com";
  const newPassword = "cosmy13647";

  superadmin.email = newEmail;
  superadmin.password = await bcrypt.hash(newPassword, 10);
  await superadmin.save({ validateBeforeSave: false, _bypassTenantGuard: true });

  console.log("Updated superadmin credentials for:", superadmin._id.toString());
  process.exit(0);
};

run();
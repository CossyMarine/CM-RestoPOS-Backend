// scripts/createSuperAdmin.js — run ONCE
import "dotenv/config";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import User from "../models/User.js";

const run = async () => {
  await mongoose.connect(process.env.MONGO_URI);

  const existing = await User.findOne({ role: "superadmin", _bypassTenantGuard: true });
  if (existing) {
    console.log("Superadmin already exists:", existing._id.toString());
    process.exit(0);
  }

  const password = "REPLACE_WITH_A_STRONG_PASSWORD";
  const hashed = await bcrypt.hash(password, 10);

  const superadmin = await User.create({
    fullName: "Platform Superadmin",
    email: "REPLACE_WITH_YOUR_EMAIL",
    password: hashed,
    role: "superadmin",
    isAdmin: false,
  });

  console.log("Created superadmin:", superadmin._id.toString());
  process.exit(0);
};

run();
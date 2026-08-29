// scripts/createSuperAdmin.js — run ONCE
import "dotenv/config";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import User from "../models/User.js";

const run = async () => {
  await mongoose.connect(process.env.MONGO_URI);

  const existing = await User.findOne({ role: "superadmin" });
  if (existing) {
    console.log("Superadmin already exists:", existing._id.toString());
    process.exit(0);
  }

  const password = "Cosymarine123#";
  const hashed = await bcrypt.hash(password, 10);

  const superadmin = await User.create({
    fullName: "Platform Superadmin",
    email: "shidayawatukibwari@gmail.com",
    password: hashed,
    role: "superadmin",
    isAdmin: false,
  });

  console.log("Created superadmin:", superadmin._id.toString());
  process.exit(0);
};

run();
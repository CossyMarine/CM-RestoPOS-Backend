// seed.js
import dotenv from "dotenv";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import User from "./models/User.js";

dotenv.config();

const seed = async () => {
  await mongoose.connect(process.env.MONGO_URI);

  const hashed = await bcrypt.hash("admin123", 10);

  await User.create({
    fullName: "System Admin",
    email: "admin@restopos.com",
    password: hashed,
    isAdmin: true,
  });

  console.log("✅ Admin created successfully (admin@restopos.com / admin123)");
  process.exit(0);
};

seed().catch((err) => {
  console.error("❌ Seed failed:", err);
  process.exit(1);
});

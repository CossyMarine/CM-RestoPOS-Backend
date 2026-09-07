// scripts/setShortcodeType.js — run once, adjust businessId/type as needed
import "dotenv/config";
import mongoose from "mongoose";
import PaymentConfig from "../models/PaymentConfig.js";

const run = async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const businessId = "PASTE_THE_BUSINESS_ID_HERE";
  const type = "paybill"; // or "till"

  const result = await PaymentConfig.findOneAndUpdate(
    { businessId, provider: "mpesa", _bypassTenantGuard: true },
    { shortcodeType: type },
    { new: true }
  );
  console.log(result);

  await mongoose.disconnect();
  process.exit(0);
};

run();
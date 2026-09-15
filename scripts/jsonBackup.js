// scripts/jsonBackup.js
import "dotenv/config";
import mongoose from "mongoose";
import fs from "fs";
import path from "path";

const run = async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;

  const dir = `./backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  fs.mkdirSync(dir, { recursive: true });

  const collections = await db.listCollections().toArray();
  for (const { name } of collections) {
    if (name.startsWith("system.")) continue;
    const docs = await db.collection(name).find({}).toArray();
    fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(docs, null, 2));
    console.log(`Backed up ${name}: ${docs.length} document(s)`);
  }

  console.log(`\nDone. Backup saved to ${dir}`);
  await mongoose.disconnect();
  process.exit(0);
};

run().catch(async (err) => {
  console.error("Backup failed:", err);
  await mongoose.disconnect();
  process.exit(1);
});
// scripts/wipeAllExceptSuperadmin.js
//
// DESTRUCTIVE. Deletes every document in the database except User records
// with role: "superadmin". Businesses, orders, receipts, inventory,
// everything — gone, no undo.
//
// SAFETY: run WITHOUT --confirm first. It only reports counts, deletes
// nothing. Only add --confirm once you've read that report and taken a
// backup (see command printed below).
//
// Usage:
//   node scripts/wipeAllExceptSuperadmin.js            (dry run — reports only)
//   node scripts/wipeAllExceptSuperadmin.js --confirm   (actually deletes)

import "dotenv/config";
import mongoose from "mongoose";
import readline from "readline";

const CONFIRM = process.argv.includes("--confirm");

const ask = (question) =>
  new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });

const run = async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;
  const dbName = db.databaseName;

  console.log(`Connected to database: "${dbName}"`);
  console.log(
    `\nBefore running with --confirm, back this up:\n` +
    `  mongodump --uri="${process.env.MONGO_URI}" --out=./backup-$(date +%Y%m%d-%H%M%S)\n`
  );

  const collections = await db.listCollections().toArray();
  const usersCollection = collections.find((c) => c.name === "users");

  // Count what would be affected
  let totalOther = 0;
  const report = [];
  for (const { name } of collections) {
    if (name.startsWith("system.")) continue;
    if (name === "users") continue;
    const count = await db.collection(name).countDocuments({});
    if (count > 0) report.push({ name, count });
    totalOther += count;
  }

  const superadminCount = usersCollection
    ? await db.collection("users").countDocuments({ role: "superadmin" })
    : 0;
  const nonSuperadminUserCount = usersCollection
    ? await db.collection("users").countDocuments({ role: { $ne: "superadmin" } })
    : 0;

  console.log("Would delete:");
  report.forEach(({ name, count }) => console.log(`  ${name}: ${count}`));
  console.log(`  users (non-superadmin): ${nonSuperadminUserCount}`);
  console.log(`\nWould KEEP: users (superadmin): ${superadminCount}`);
  console.log(`\nTotal documents to delete: ${totalOther + nonSuperadminUserCount}`);

  if (superadminCount === 0) {
    console.error(
      "\n⚠️  No superadmin user found in this database. Refusing to continue — " +
      "if this ran, you'd be left with zero logins. Aborting."
    );
    process.exit(1);
  }

  if (!CONFIRM) {
    console.log("\nDry run only — nothing deleted. Re-run with --confirm to proceed.");
    process.exit(0);
  }

  console.log(`\n⚠️  You are about to PERMANENTLY WIPE database "${dbName}".`);
  const typed = await ask(`Type the database name ("${dbName}") to proceed: `);
  if (typed !== dbName) {
    console.log("Name did not match. Aborting — nothing was deleted.");
    process.exit(1);
  }

  console.log("\nDeleting...");
  for (const { name } of collections) {
    if (name.startsWith("system.")) continue;
    if (name === "users") continue;
    const { deletedCount } = await db.collection(name).deleteMany({});
    console.log(`  ${name}: deleted ${deletedCount}`);
  }

  if (usersCollection) {
    const { deletedCount } = await db.collection("users").deleteMany({ role: { $ne: "superadmin" } });
    console.log(`  users: deleted ${deletedCount} (kept ${superadminCount} superadmin)`);
  }

  console.log("\nDone.");
  await mongoose.disconnect();
  process.exit(0);
};

run().catch(async (err) => {
  console.error("Wipe failed:", err);
  await mongoose.disconnect();
  process.exit(1);
});
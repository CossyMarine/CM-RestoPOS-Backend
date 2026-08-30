/**
 * WARNING:
 * Run this only AFTER deploying the corrected schema files that define the
 * tenant-scoped compound indexes. Test against a staging copy first if these
 * collections contain real production data.
 *
 * This script changes indexes only. It does not backfill or correct businessId
 * values; run backfillBusinessId.js separately before this migration.
 */

import "dotenv/config";
import mongoose from "mongoose";

import User from "../models/User.js";
import Counter from "../models/Counter.js";
import PurchaseOrder from "../models/PurchaseOrder.js";
import Supplier from "../models/Supplier.js";
import Receipt from "../models/Receipt.js";
import Recipe from "../models/Recipe.js";
import InventoryStock from "../models/InventoryStock.js";

if (!process.env.MONGO_URI) {
  throw new Error("MONGO_URI is required.");
}

const migrations = [
  {
    model: User,
    oldIndexes: ["email_1", "phone_1"],
  },
  {
    model: Counter,
    oldIndexes: ["name_1"],
  },
  {
    model: PurchaseOrder,
    oldIndexes: ["poNumber_1"],
  },
  {
    model: Supplier,
    oldIndexes: ["name_1"],
  },
  {
    model: Receipt,
    oldIndexes: ["billId_1"],
  },
  {
    model: Recipe,
    oldIndexes: ["menuItem_1"],
  },
  {
    model: InventoryStock,
    oldIndexes: ["item_1_location_1"],
  },
];

const summary = [];

function isMissingIndexError(error) {
  return (
    error?.codeName === "IndexNotFound" ||
    error?.codeName === "NamespaceNotFound" ||
    error?.code === 27 ||
    error?.code === 26
  );
}

async function getIndexes(model) {
  return model.collection.listIndexes().toArray();
}

async function syncModelIndexes({ model, oldIndexes }) {
  const result = {
    model: model.modelName,
    collection: model.collection.name,
    dropped: [],
    alreadyAbsent: [],
    errors: [],
  };

  console.log(`\n${"=".repeat(72)}`);
  console.log(`${result.model} (${result.collection})`);
  console.log("Current indexes:");

  try {
    console.table(await getIndexes(model));
  } catch (error) {
    result.errors.push(`Could not list current indexes: ${error.message}`);
    console.error(`Could not list current indexes: ${error.message}`);
  }

  for (const indexName of oldIndexes) {
    try {
      await model.collection.dropIndex(indexName);
      result.dropped.push(indexName);
      console.log(`Dropped old index: ${indexName}`);
    } catch (error) {
      if (isMissingIndexError(error)) {
        result.alreadyAbsent.push(indexName);
        console.log(`Old index already absent: ${indexName}`);
      } else {
        result.errors.push(`Could not drop ${indexName}: ${error.message}`);
        console.error(`Could not drop ${indexName}: ${error.message}`);
      }
    }
  }

  try {
    const syncResult = await model.syncIndexes();
    console.log("syncIndexes() completed.", syncResult);
  } catch (error) {
    result.errors.push(`syncIndexes failed: ${error.message}`);
    console.error(`syncIndexes failed: ${error.message}`);
  }

  console.log("Final indexes:");

  try {
    console.table(await getIndexes(model));
  } catch (error) {
    result.errors.push(`Could not list final indexes: ${error.message}`);
    console.error(`Could not list final indexes: ${error.message}`);
  }

  summary.push(result);
}

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log(`Connected to MongoDB: ${mongoose.connection.name}`);

  for (const migration of migrations) {
    await syncModelIndexes(migration);
  }

  console.log(`\n${"=".repeat(72)}`);
  console.log("TENANT INDEX SYNC SUMMARY");

  for (const result of summary) {
    console.log(`\n${result.model} (${result.collection})`);
    console.log(
      `  Dropped: ${
        result.dropped.length ? result.dropped.join(", ") : "none"
      }`
    );
    console.log(
      `  Already absent: ${
        result.alreadyAbsent.length ? result.alreadyAbsent.join(", ") : "none"
      }`
    );
    console.log(
      `  Errors: ${result.errors.length ? result.errors.join(" | ") : "none"}`
    );
  }

  const errorCount = summary.reduce(
    (count, result) => count + result.errors.length,
    0
  );

  if (errorCount > 0) {
    process.exitCode = 1;
    console.error(`\nCompleted with ${errorCount} error(s).`);
  } else {
    console.log("\nCompleted successfully.");
  }
}

main()
  .catch((error) => {
    process.exitCode = 1;
    console.error("Fatal index migration error:", error);
  })
  .finally(async () => {
    await mongoose.disconnect();
    console.log("Disconnected from MongoDB.");
  });
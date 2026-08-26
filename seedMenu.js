// seedMenu.js — run ONCE from your backend's root folder, then delete this file.
// Usage:  node seedMenu.js
//
// Inserts the menu items below into your existing MenuItem collection.
// Safe to re-run: it skips any item whose name already exists, so running
// it twice by accident won't create duplicates.

import "dotenv/config";
import mongoose from "mongoose";
import MenuItem from "./models/MenuItem.js";

const items = [
  // Hot Beverages
  { name: "Tea Masala", price: 200, category: "Hot Beverages" },
  { name: "Mixed Tea / African Tea", price: 150, category: "Hot Beverages" },
  { name: "White Coffee", price: 200, category: "Hot Beverages" },
  { name: "Black Coffee", price: 150, category: "Hot Beverages" },
  { name: "Lemon Tea", price: 200, category: "Hot Beverages" },
  { name: "White Chocolate", price: 200, category: "Hot Beverages" },
  { name: "Lemon & Honey", price: 200, category: "Hot Beverages" },
  { name: "Dawa", price: 200, category: "Hot Beverages" },
  { name: "Uji", price: 200, category: "Hot Beverages" },
  { name: "Hot Water", price: 50, category: "Hot Beverages" },

  // Cold Beverages
  { name: "Juice", price: 200, category: "Cold Beverages" },
  { name: "Soda", price: 100, category: "Cold Beverages" },
  { name: "Belmonte", price: 400, category: "Cold Beverages" },
  { name: "Minute Maid", price: 150, category: "Cold Beverages" },
  { name: "Munsik Cup", price: 60, category: "Cold Beverages" },

  // Snacks
  { name: "Samosa (Pair)", price: 200, category: "Snacks" },
  { name: "Chapati", price: 50, category: "Snacks" },
  { name: "Mandazi", price: 50, category: "Snacks" },
  { name: "Sausage", price: 100, category: "Snacks" },
  { name: "Omelette", price: 200, category: "Snacks" },
  { name: "Spanish Omelette", price: 200, category: "Snacks" },
  { name: "Kebabs", price: 200, category: "Snacks" },

  // Main Meals
  { name: "Githeri", price: 250, category: "Main Meals" },
  { name: "Beans", price: 250, category: "Main Meals" },
  { name: "Peas", price: 250, category: "Main Meals" },
  { name: "Pilau", price: 300, category: "Main Meals" },
  { name: "Rice Plain", price: 250, category: "Main Meals" },
  { name: "Chips", price: 200, category: "Main Meals" },
  { name: "Chips T/A", price: 250, category: "Main Meals" },
  { name: "Chips Masala", price: 300, category: "Main Meals" },
  { name: "Chips Kuku (Broiler)", price: 600, category: "Main Meals" },
  { name: "Chips Kuku (Kienyeji)", price: 700, category: "Main Meals" },
  { name: "Cabbage", price: 50, category: "Main Meals" },
  { name: "Kuku Kienyeji 1/4", price: 600, category: "Main Meals" },
  { name: "Kuku Broiler 1/4", price: 500, category: "Main Meals" },
  { name: "Beef Stew / Wet Fry", price: 300, category: "Main Meals" },
  { name: "Beef Dry Fry", price: 350, category: "Main Meals" },
  { name: "Mbuzi Stew / Wet Fry", price: 300, category: "Main Meals" },
  { name: "Mbuzi Dry Fry", price: 350, category: "Main Meals" },
  { name: "Tumbukiza 1kg", price: 1500, category: "Main Meals" },
  { name: "Tumbukiza 1/2kg", price: 750, category: "Main Meals" },
  { name: "Mbuzi Choma 1kg", price: 1700, category: "Main Meals" },
  { name: "Soup", price: 50, category: "Main Meals" },
  { name: "Ugali Plain", price: 60, category: "Main Meals" },
  { name: "Sauté Potatoes", price: 300, category: "Main Meals" },
  { name: "Scrambled Egg", price: 200, category: "Main Meals" },
  { name: "Fish", price: 600, category: "Main Meals" },
  { name: "Matumbo", price: 250, category: "Main Meals" },
  { name: "Managu", price: 150, category: "Main Meals" },
];

const run = async () => {
  await mongoose.connect(process.env.MONGO_URI);
  console.log("Connected. Seeding menu...");

  let created = 0;
  let skipped = 0;

  for (const item of items) {
    const exists = await MenuItem.findOne({ name: item.name });
    if (exists) {
      skipped++;
      continue;
    }
    await MenuItem.create(item);
    created++;
  }

  console.log(`Done. Created: ${created}, skipped (already existed): ${skipped}`);
  await mongoose.disconnect();
  process.exit(0);
};

run().catch((err) => {
  console.error("Seed failed:", err.message);
  process.exit(1);
});
// scripts/reseedMenu.js — run ONCE: node scripts/reseedMenu.js
// WARNING: this DELETES every existing MenuItem before inserting the new list.
// There is no undo — make sure you actually want a clean slate before running.

import "dotenv/config";
import mongoose from "mongoose";
import MenuItem from "../models/MenuItem.js";

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
  console.log("Connected.");

  const { deletedCount } = await MenuItem.deleteMany({});
  console.log(`Deleted ${deletedCount} existing menu item(s).`);

  const created = await MenuItem.insertMany(items);
  console.log(`Inserted ${created.length} new menu item(s).`);

  await mongoose.disconnect();
  process.exit(0);
};

run().catch((err) => {
  console.error("Reseed failed:", err.message);
  process.exit(1);
});
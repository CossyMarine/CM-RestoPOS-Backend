import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";

import app from "../app.js";
import Business from "../models/Business.js";
import User from "../models/User.js";
import Order from "../models/Order.js";
import Receipt from "../models/Receipt.js";

let server;
let baseUrl;
let businessA;
let businessB;
let tokenA;
let receiptB;

before(async () => {
  if (!process.env.MONGO_URI) {
    throw new Error("MONGO_URI is missing. Run tests with .env.test.");
  }

  await mongoose.connect(process.env.MONGO_URI);

  // Safe only because .env.test must point to restopos_test.
  await mongoose.connection.dropDatabase();

  businessA = await Business.create({ name: "Test Business A" });
  businessB = await Business.create({ name: "Test Business B" });

  const adminA = await User.create({
    fullName: "Admin A",
    email: "admin-a@example.test",
    password: "not-used-in-this-test",
    isAdmin: true,
    role: "customer",
    businessId: businessA._id,
  });

  tokenA = jwt.sign(
    { id: adminA._id, businessId: businessA._id },
    process.env.JWT_SECRET,
    { algorithm: "HS256", expiresIn: "1h" }
  );

  const orderB = await Order.create({
    businessId: businessB._id,
    tableNumber: "B-1",
    items: [
      {
        mealName: "Tenant B Test Meal",
        quantity: 1,
        unitPrice: 100,
        lineTotal: 100,
      },
    ],
    subtotal: 100,
    status: "pending",
  });

  receiptB = await Receipt.create({
    businessId: businessB._id,
    billId: "B-TEST-001",
    order: orderB._id,
    tableNumber: "B-1",
    items: orderB.items,
    subtotal: 100,
    totalDue: 100,
    status: "unpaid",
  });

  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));

  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );

  await mongoose.disconnect();
});

test("Business A cannot read Business B's receipt", async () => {
  const response = await fetch(`${baseUrl}/api/receipts/${receiptB._id}`, {
    headers: {
      Cookie: `token=${tokenA}`,
    },
  });

  assert.equal(response.status, 404);
});

test("Business A cannot mark Business B's receipt as printed", async () => {
  const response = await fetch(
    `${baseUrl}/api/receipts/${receiptB._id}/print`,
    {
      method: "PATCH",
      headers: {
        Cookie: `token=${tokenA}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    }
  );

  assert.equal(response.status, 404);

  const unchangedReceipt = await Receipt.findById(receiptB._id);
  assert.equal(unchangedReceipt.printed, undefined);
});
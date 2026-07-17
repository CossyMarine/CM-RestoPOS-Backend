// app.js
import express from "express";
import dotenv from "dotenv";
import cors from "cors";

// Routes
import authRoutes from "./routes/authRoutes.js";
import menuRoutes from "./routes/menuRoutes.js";
import orderRoutes from "./routes/orderRoutes.js";
import receiptRoutes from "./routes/receiptRoutes.js";
import shiftRoutes from "./routes/shiftRoutes.js";
import voidRequestRoutes from "./routes/voidRequestRoutes.js";
import revenueRoutes from "./routes/revenueRoutes.js";

dotenv.config();

/* =================================================
   APP
================================================= */
const app = express();

app.set("trust proxy", 1);

/* CORS */
const ALLOWED_ORIGINS = [
  "https://restopos-pi.vercel.app",
  "http://localhost:3000", // local dev
];

app.use(
  cors({
    origin: ALLOWED_ORIGINS,
    credentials: true,
  })
);

/* Body parser */
app.use(express.json());

/* Health check */
app.get("/", (req, res) => {
  res.json({ status: "RPS backend running" });
});

/* =================================================
   ROUTES
================================================= */
app.use("/api/auth", authRoutes);
app.use("/api/menu", menuRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/receipts", receiptRoutes);
app.use("/api/shifts", shiftRoutes);
app.use("/api/void-requests", voidRequestRoutes);
app.use("/api/revenue", revenueRoutes);

export default app;


import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import mongoSanitize from "express-mongo-sanitize";

// Routes
import authRoutes from "./routes/authRoutes.js";
import menuRoutes from "./routes/menuRoutes.js";
import orderRoutes from "./routes/orderRoutes.js";
import receiptRoutes from "./routes/receiptRoutes.js";
import shiftRoutes from "./routes/shiftRoutes.js";
import voidRequestRoutes from "./routes/voidRequestRoutes.js";
import revenueRoutes from "./routes/revenueRoutes.js";
import settingsRoutes from "./routes/settingsRoutes.js";
import walletRoutes from "./routes/walletRoutes.js";
import paymentRoutes from "./routes/paymentRoutes.js";
import waiterRoutes from "./routes/waiterRoutes.js";
import kitchenSettingsRoutes from "./routes/kitchenSettingsRoutes.js";
import notificationSoundRoutes from "./routes/notificationSoundRoutes.js";
import inventoryRoutes from "./routes/inventoryRoutes.js";
import accountantRoutes from "./routes/accountantRoutes.js";
import reportsRoutes from "./routes/reportsRoutes.js";

dotenv.config();

/* =================================================
   APP
================================================= */
const app = express();

app.set("trust proxy", 1);

/* CORS — credentials:true is required so the httpOnly auth cookie is sent */
const ALLOWED_ORIGINS = [
    "https://cm-resto-pos-frontend-djfuwhc1n.vercel.app",
    "https://cm-resto-pos-frontend.vercel.app",
    "http://localhost:3000",
    "http://localhost:5173",
];

app.use(
    cors({
        origin: ALLOWED_ORIGINS,
        credentials: true,
    })
);

/* Body parser */
app.use(express.json());

/* Cookie parser — required to read the httpOnly auth cookie */
app.use(cookieParser());

/* Security headers */
app.use(helmet());

/* Strip any request field that looks like a MongoDB operator (e.g. "$ne")
   so nobody can smuggle query logic through a login/search field. */
app.use(mongoSanitize());

/* General API rate limit — generous, just stops a runaway client or basic
   flood from one source. Doesn't affect normal restaurant traffic at all. */
app.use(
    rateLimit({
        windowMs: 15 * 60 * 1000, // 15 minutes
        max: 300,
        standardHeaders: true,
        legacyHeaders: false,
        message: {
            message:
                "Too many requests — please slow down and try again shortly.",
        },
    })
);

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
app.use("/api/settings", settingsRoutes);
app.use("/api/wallet", walletRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/waiters", waiterRoutes);
app.use("/api/kitchen-settings", kitchenSettingsRoutes);
app.use("/api/notification-sounds", notificationSoundRoutes);
app.use("/api/inventory", inventoryRoutes);
app.use("/api/accountants", accountantRoutes);
app.use("/api/reports", reportsRoutes);

export default app;

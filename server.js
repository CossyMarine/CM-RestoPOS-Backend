import mongoose from "mongoose";
import dotenv from "dotenv";
import app from "./app.js";
import http from "http";
import { Server } from "socket.io";
import { seedDefaultInventoryLocations } from "./models/InventoryLocation.js";

dotenv.config();

/* ========================================
   🗄️ CONNECT TO MONGODB
======================================== */
mongoose
  .connect(process.env.MONGO_URI)
  .then(async () => {
    console.log("✅ MongoDB connected");
    try {
      await seedDefaultInventoryLocations();
      console.log("✅ Inventory locations seeded");
    } catch (error) {
      console.error("❌ Inventory location seeding error:", error.message);
    }
  })
  .catch((err) => console.log("❌ MongoDB error:", err));

const PORT = process.env.PORT || 5000;

/* ========================================
   🌐 CREATE HTTP SERVER
======================================== */
const server = http.createServer(app);

/* ========================================
   🔌 SOCKET.IO SETUP
======================================== */
const ALLOWED_ORIGINS = [
  "https://cm-resto-pos-frontend.vercel.app",
  "https://cm-resto-pos-frontend-fb21.vercel.app",
  "https://cm-resto-pos-frontend-fb21-o9fa6zt6s.vercel.app",
  "http://localhost:3000",
];

export const io = new Server(server, {
  cors: {
    origin: ALLOWED_ORIGINS,
    methods: ["GET", "POST", "PATCH"],
  },
});

/* Make io accessible in routes/controllers via req.app.get("io") */
app.set("io", io);

/* ========================================
   🔗 SOCKET CONNECTION — ROOMS
   Rooms let a screen subscribe only to what it needs, e.g. a
   kitchen display joins "kitchen" instead of hearing every event.
======================================== */
io.on("connection", (socket) => {
  console.log("🔌 New client connected:", socket.id);

  socket.on("join_room", (room) => {
    socket.join(room);
  });

  socket.on("leave_room", (room) => {
    socket.leave(room);
  });

  socket.on("disconnect", () => {
    console.log("❌ Client disconnected:", socket.id);
  });
});

/* ========================================
   🚀 START SERVER
======================================== */
server.listen(PORT, () =>
  console.log(`🚀 Server running on port ${PORT}`)
);

import { createClient } from "redis";
import dotenv from "dotenv";

dotenv.config();

const CACHE_TTL_SECONDS = 300;
let client = null;
let connecting = false;

const getRedisClient = async () => {
  if (!process.env.REDIS_URL) {
    return null;
  }

  if (client) {
    return client;
  }

  if (connecting) {
    return null;
  }

  connecting = true;

  try {
    client = createClient({ url: process.env.REDIS_URL });
    client.on("error", (err) => {
      console.error("Redis error:", err.message);
    });

    await client.connect();
    return client;
  } catch (error) {
    console.error("Redis unavailable:", error.message);
    client = null;
    return null;
  } finally {
    connecting = false;
  }
};

export const redisService = {
  async get(key) {
    try {
      const redis = await getRedisClient();
      if (!redis) return null;

      const value = await redis.get(key);
      return value ? JSON.parse(value) : null;
    } catch (error) {
      console.error("Redis get failed:", error.message);
      return null;
    }
  },

  async set(key, value, ttlSeconds = CACHE_TTL_SECONDS) {
    try {
      const redis = await getRedisClient();
      if (!redis) return false;

      await redis.set(key, JSON.stringify(value), { EX: ttlSeconds });
      return true;
    } catch (error) {
      console.error("Redis set failed:", error.message);
      return false;
    }
  },

  async del(key) {
    try {
      const redis = await getRedisClient();
      if (!redis) return false;

      await redis.del(key);
      return true;
    } catch (error) {
      console.error("Redis delete failed:", error.message);
      return false;
    }
  },
};

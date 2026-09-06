// utils/encryption.js
import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // recommended for GCM
const AUTH_TAG_LENGTH = 16;

function getKey() {
  const keyHex = process.env.PAYMENT_ENCRYPTION_KEY;
  if (!keyHex) {
    throw new Error("PAYMENT_ENCRYPTION_KEY is not set — refusing to handle payment credentials");
  }
  const key = Buffer.from(keyHex, "hex");
  if (key.length !== 32) {
    throw new Error("PAYMENT_ENCRYPTION_KEY must be a 32-byte value, hex-encoded (64 hex chars)");
  }
  return key;
}

// Returns a single self-contained string: iv.authTag.ciphertext (all base64).
// Storing all three together means each field is independently decryptable
// without needing companion columns.
export function encrypt(plaintext) {
  if (plaintext === undefined || plaintext === null || plaintext === "") return null;

  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const ciphertext = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [iv.toString("base64"), authTag.toString("base64"), ciphertext.toString("base64")].join(".");
}

export function decrypt(payload) {
  if (!payload) return null;

  const [ivB64, authTagB64, ciphertextB64] = payload.split(".");
  if (!ivB64 || !authTagB64 || !ciphertextB64) {
    throw new Error("Malformed encrypted payload");
  }

  const key = getKey();
  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(authTagB64, "base64");
  const ciphertext = Buffer.from(ciphertextB64, "base64");

  if (authTag.length !== AUTH_TAG_LENGTH) {
    throw new Error("Malformed auth tag");
  }

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}
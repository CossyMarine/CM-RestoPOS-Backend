// test-encryption.js
import dotenv from "dotenv";
dotenv.config();

import { encrypt, decrypt } from "./utils/encryption.js";

const secret = "my-test-consumer-secret-123";
const enc = encrypt(secret);
console.log("Encrypted:", enc);
console.log("Decrypted:", decrypt(enc));
console.log("Match:", decrypt(enc) === secret);
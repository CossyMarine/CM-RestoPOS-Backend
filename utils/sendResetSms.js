// utils/sendResetSms.js
import axios from "axios";

const OPENSMS_BASE = "https://opensms.co.ke/api/v3";
const TOKEN = process.env.OPENSMS_API_TOKEN;

const client = axios.create({
  baseURL: OPENSMS_BASE,
  headers: {
    Authorization: `Bearer ${TOKEN}`,
    Accept: "application/json",
  },
  timeout: 10000,
});

// channel: "sms" | "whatsapp"
export const sendResetCode = async ({ to, code, channel = "sms" }) => {
  const message = `Your RestoPOS password reset code is ${code}. It expires in 10 minutes.`;

  // ⚠️ CONFIRM WITH OPENSMS DOCS: only /sms/send was given to us explicitly.
  // The path below for whatsapp is an assumption — check your OpenSMS
  // dashboard/docs for the actual WhatsApp endpoint + payload field names.
  const path = channel === "whatsapp" ? "/whatsapp/send" : "/sms/send";

  const payload = {
    to,               // recipient phone number, e.g. 2547XXXXXXXX
    message,
    sender_id: process.env.OPENSMS_SENDER_ID || undefined,
  };

  const { data } = await client.post(path, payload);
  return data;
};

export default sendResetCode;

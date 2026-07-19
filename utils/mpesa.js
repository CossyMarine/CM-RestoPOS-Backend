// utils/mpesa.js
// Minimal Daraja (M-Pesa) STK Push client — access token, STK push, STK query.
import axios from "axios";

const isProd = (process.env.MPESA_ENV || "sandbox") === "production";
const BASE_URL = isProd
  ? "https://api.safaricom.co.ke"
  : "https://sandbox.safaricom.co.ke";

let cachedToken = null;
let cachedTokenExpiry = 0;

export const getAccessToken = async () => {
  if (cachedToken && Date.now() < cachedTokenExpiry) return cachedToken;

  const key = process.env.MPESA_CONSUMER_KEY;
  const secret = process.env.MPESA_CONSUMER_SECRET;

  if (!key || !secret) {
    throw new Error("MPESA_CONSUMER_KEY / MPESA_CONSUMER_SECRET not configured");
  }

  const auth = Buffer.from(`${key}:${secret}`).toString("base64");

  const { data } = await axios.get(
    `${BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
    { headers: { Authorization: `Basic ${auth}` } }
  );

  cachedToken = data.access_token;
  cachedTokenExpiry = Date.now() + (Number(data.expires_in || 3599) - 60) * 1000;
  return cachedToken;
};

const timestamp = () => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return (
    d.getFullYear().toString() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
};

const buildPassword = (ts) => {
  const shortcode = process.env.MPESA_SHORTCODE;
  const passkey = process.env.MPESA_PASSKEY;
  return Buffer.from(`${shortcode}${passkey}${ts}`).toString("base64");
};

// Normalizes 07xx / 01xx / +2547xx / 2547xx -> 2547xxxxxxxx
export const formatMpesaPhone = (phone) => {
  let p = String(phone || "").replace(/\D/g, "");
  if (p.startsWith("0")) p = "254" + p.slice(1);
  else if (p.startsWith("7") || p.startsWith("1")) p = "254" + p;

  if (p.startsWith("254") && p.length === 12) return p;
  throw new Error("Enter a valid Safaricom M-Pesa number, e.g. 0712345678");
};

export const stkPush = async ({ phone, amount, accountRef, description }) => {
  const token = await getAccessToken();
  const ts = timestamp();
  const shortcode = process.env.MPESA_SHORTCODE;
  const formattedPhone = formatMpesaPhone(phone);

  const payload = {
    BusinessShortCode: shortcode,
    Password: buildPassword(ts),
    Timestamp: ts,
    TransactionType: process.env.MPESA_TRANSACTION_TYPE || "CustomerBuyGoodsOnline",
    Amount: Math.max(1, Math.ceil(amount)),
    PartyA: formattedPhone,
    PartyB: shortcode,
    PhoneNumber: formattedPhone,
    CallBackURL: process.env.MPESA_CALLBACK_URL,
    AccountReference: (accountRef || "RestoPOS").slice(0, 12),
    TransactionDesc: (description || "Bill payment").slice(0, 13),
  };

  const { data } = await axios.post(
    `${BASE_URL}/mpesa/stkpush/v1/processrequest`,
    payload,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  return data; // { MerchantRequestID, CheckoutRequestID, ResponseCode, ResponseDescription, ... }
};

export const stkQuery = async (checkoutRequestId) => {
  const token = await getAccessToken();
  const ts = timestamp();
  const shortcode = process.env.MPESA_SHORTCODE;

  const payload = {
    BusinessShortCode: shortcode,
    Password: buildPassword(ts),
    Timestamp: ts,
    CheckoutRequestID: checkoutRequestId,
  };

  const { data } = await axios.post(
    `${BASE_URL}/mpesa/stkpushquery/v1/query`,
    payload,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  return data; // { ResultCode, ResultDesc, ... }
};

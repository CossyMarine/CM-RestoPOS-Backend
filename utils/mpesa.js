// utils/mpesa.js
// Minimal Daraja (M-Pesa) STK Push client — access token, STK push, STK query.
// Credentials are passed in per-call, never read from process.env directly —
// each business supplies its own via PaymentConfig, since M-Pesa is
// per-tenant, not platform-wide.
import axios from "axios";

const BASE_URLS = {
  sandbox: "https://sandbox.safaricom.co.ke",
  production: "https://api.safaricom.co.ke",
};

// Token cache keyed by consumerKey — each business's token is cached
// independently, since each business has its own Daraja app credentials.
const tokenCache = new Map(); // consumerKey -> { token, expiry }

export const getAccessToken = async ({ consumerKey, consumerSecret, environment }) => {
  const cached = tokenCache.get(consumerKey);
  if (cached && Date.now() < cached.expiry) return cached.token;

  if (!consumerKey || !consumerSecret) {
    throw new Error("M-Pesa consumer key/secret not configured for this business");
  }

  const BASE_URL = BASE_URLS[environment] || BASE_URLS.sandbox;
  const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString("base64");

  const { data } = await axios.get(
    `${BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
    { headers: { Authorization: `Basic ${auth}` } }
  );

  tokenCache.set(consumerKey, {
    token: data.access_token,
    expiry: Date.now() + (Number(data.expires_in || 3599) - 60) * 1000,
  });

  return data.access_token;
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

const buildPassword = (shortcode, passkey, ts) =>
  Buffer.from(`${shortcode}${passkey}${ts}`).toString("base64");

// Normalizes 07xx / 01xx / +2547xx / 2547xx -> 2547xxxxxxxx
export const formatMpesaPhone = (phone) => {
  let p = String(phone || "").replace(/\D/g, "");
  if (p.startsWith("0")) p = "254" + p.slice(1);
  else if (p.startsWith("7") || p.startsWith("1")) p = "254" + p;

  if (p.startsWith("254") && p.length === 12) return p;
  throw new Error("Enter a valid Safaricom M-Pesa number, e.g. 0712345678");
};

export const stkPush = async ({
  phone,
  amount,
  accountRef,
  description,
  shortcode,
  consumerKey,
  consumerSecret,
  passkey,
  environment,
  callbackUrl,
  transactionType,
}) => {
  const token = await getAccessToken({ consumerKey, consumerSecret, environment });
  const ts = timestamp();
  const formattedPhone = formatMpesaPhone(phone);
  const BASE_URL = BASE_URLS[environment] || BASE_URLS.sandbox;

  const payload = {
    BusinessShortCode: shortcode,
    Password: buildPassword(shortcode, passkey, ts),
    Timestamp: ts,
    TransactionType: transactionType || "CustomerBuyGoodsOnline",
    Amount: Math.max(1, Math.ceil(amount)),
    PartyA: formattedPhone,
    PartyB: shortcode,
    PhoneNumber: formattedPhone,
    CallBackURL: callbackUrl,
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

export const stkQuery = async ({ checkoutRequestId, shortcode, consumerKey, consumerSecret, passkey, environment }) => {
  const token = await getAccessToken({ consumerKey, consumerSecret, environment });
  const ts = timestamp();
  const BASE_URL = BASE_URLS[environment] || BASE_URLS.sandbox;

  const payload = {
    BusinessShortCode: shortcode,
    Password: buildPassword(shortcode, passkey, ts),
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
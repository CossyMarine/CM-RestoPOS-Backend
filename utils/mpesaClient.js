// utils/mpesaClient.js
import axios from "axios";

const BASE_URLS = {
  sandbox: "https://sandbox.safaricom.co.ke",
  production: "https://api.safaricom.co.ke",
};

function timestamp() {
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
}

async function getAccessToken({ consumerKey, consumerSecret, environment }) {
  const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString("base64");
  const { data } = await axios.get(
    `${BASE_URLS[environment]}/oauth/v1/generate?grant_type=client_credentials`,
    { headers: { Authorization: `Basic ${auth}` } }
  );
  return data.access_token;
}

// Initiates an STK push. Returns Safaricom's { MerchantRequestID, CheckoutRequestID }
// on success, or throws on a request-level failure (network, bad credentials).
// Note: a 200 here only means "the push was sent to the phone" — the actual
// payment result comes later via the callback, not this response.
export async function initiateStkPush({
  shortcode,
  consumerKey,
  consumerSecret,
  passkey,
  environment,
  phoneNumber,
  amount,
  accountReference,
  transactionDesc,
  callbackUrl,
}) {
  const accessToken = await getAccessToken({ consumerKey, consumerSecret, environment });
  const ts = timestamp();
  const password = Buffer.from(`${shortcode}${passkey}${ts}`).toString("base64");

  const { data } = await axios.post(
    `${BASE_URLS[environment]}/mpesa/stkpush/v1/processrequest`,
    {
      BusinessShortCode: shortcode,
      Password: password,
      Timestamp: ts,
      TransactionType: "CustomerPayBillOnline",
      Amount: Math.round(amount),
      PartyA: phoneNumber,
      PartyB: shortcode,
      PhoneNumber: phoneNumber,
      CallBackURL: callbackUrl,
      AccountReference: accountReference,
      TransactionDesc: transactionDesc || "Payment",
    },
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  return data; // { MerchantRequestID, CheckoutRequestID, ResponseCode, ... }
}
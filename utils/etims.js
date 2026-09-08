// utils/etims.js
// KRA eTIMS submission client. Endpoint/auth details are placeholders —
// swap in the real Virtual Sales Control Unit (VSCU) or OSCU integration
// spec once available. Everything calling this treats it as "may throw,
// may be slow, may be down" — that's the whole point of Phase 4.
import axios from "axios";

export async function submitReceiptToEtims({ receipt, businessTaxPin }) {
  const payload = {
    invoiceNumber: receipt.billId,
    taxPin: businessTaxPin,
    items: receipt.items.map((i) => ({
      description: i.mealName,
      quantity: i.quantity,
      unitPrice: i.unitPrice,
      total: i.lineTotal,
    })),
    totalAmount: receipt.totalDue ?? receipt.subtotal,
    taxAmount: receipt.tax?.amount ?? 0,
    timestamp: receipt.paidAt || new Date(),
  };

  const { data } = await axios.post(
    process.env.ETIMS_API_URL, // TODO: real eTIMS endpoint
    payload,
    {
      headers: { Authorization: `Bearer ${process.env.ETIMS_API_KEY}` }, // TODO: real auth scheme
      timeout: 10000, // never let a slow eTIMS hang a job indefinitely
    }
  );

  return data; // expect something like { invoiceNumber: "..." } — adjust to real response shape
}
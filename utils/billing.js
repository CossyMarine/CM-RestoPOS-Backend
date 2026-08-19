// utils/billing.js

// Computes discount amount, tax amount, and the final amount owed
// from a subtotal, an optional discount input, and the current tax settings.
export function computeBillTotals({ subtotal, discount, taxSettings }) {
  let discountAmount = 0;
  if (discount && discount.kind === "percent") {
    discountAmount = Number(((subtotal * discount.value) / 100).toFixed(2));
  } else if (discount && discount.kind === "fixed") {
    discountAmount = Number(discount.value.toFixed(2));
  }
  discountAmount = Math.min(discountAmount, subtotal); // never discount past zero

  const discountedSubtotal = Number((subtotal - discountAmount).toFixed(2));

  let taxAmount = 0;
  let totalDue = discountedSubtotal;

  if (taxSettings?.enabled) {
    const rate = taxSettings.ratePercent / 100;
    if (taxSettings.inclusive) {
      // Tax is already baked into discountedSubtotal — extract it, don't add it
      taxAmount = Number((discountedSubtotal - discountedSubtotal / (1 + rate)).toFixed(2));
      totalDue = discountedSubtotal; // total doesn't change, just how it's broken down
    } else {
      // Tax is added on top
      taxAmount = Number((discountedSubtotal * rate).toFixed(2));
      totalDue = Number((discountedSubtotal + taxAmount).toFixed(2));
    }
  }

  return { discountAmount, taxAmount, totalDue };
}
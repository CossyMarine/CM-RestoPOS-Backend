// utils/resolvePublicBusinessId.js
import Business from "../models/Business.js";

// Used by routes that have NO auth middleware in front of them (public menu,
// public settings, today's-revenue) — there is no req.businessId on these,
// so the caller normally has to pass ?businessId=<id> explicitly (e.g. after
// scanning a table QR code, the same convention checkAvailability/
// registerCustomer already use).
//
// INTERIM FALLBACK: if no businessId is given and there is currently exactly
// ONE business in the whole system, default to it. This exists so the
// frontend doesn't have to be updated the same day the backend becomes
// tenant-aware — but it stops working the moment a second business is
// created, at which point these routes go back to requiring ?businessId=
// explicitly. Don't rely on this once you're running more than one tenant;
// it's a migration convenience, not a permanent resolution strategy.
export const resolvePublicBusinessId = async (req) => {
  if (req.query.businessId) return req.query.businessId;

  const count = await Business.countDocuments({});
  if (count === 1) {
    const onlyBusiness = await Business.findOne({});
    return String(onlyBusiness._id);
  }

  return null;
};
// utils/scopedModel.js
import mongoose from "mongoose";

class TenantContextError extends Error {
  constructor(modelName) {
    super(`TenantScope: no businessId available when accessing ${modelName}`);
    this.name = "TenantContextError";
    this.status = 500;
  }
}

// Wraps a Model so every query/write is automatically scoped to one business.
// Usage: req.scope(MenuItem).find({ isAvailable: true })
//   -> actually runs MenuItem.find({ isAvailable: true, businessId })
export const scopeModel = (Model, businessId) => {
  if (!businessId) throw new TenantContextError(Model.modelName);

  const withFilter = (filter = {}) => ({ ...filter, businessId });
  const withData = (data) =>
    Array.isArray(data) ? data.map((d) => ({ ...d, businessId })) : { ...data, businessId };

  return {
    find: (filter, ...rest) => Model.find(withFilter(filter), ...rest),
    findOne: (filter, ...rest) => Model.findOne(withFilter(filter), ...rest),
    findById: (id, ...rest) => Model.findOne(withFilter({ _id: id }), ...rest),
    countDocuments: (filter) => Model.countDocuments(withFilter(filter)),
    create: (data) => Model.create(withData(data)),
    updateOne: (filter, update, opts) => Model.updateOne(withFilter(filter), update, opts),
    updateMany: (filter, update, opts) => Model.updateMany(withFilter(filter), update, opts),
    findOneAndUpdate: (filter, update, opts) => Model.findOneAndUpdate(withFilter(filter), update, opts),
    deleteOne: (filter, ...rest) => Model.deleteOne(withFilter(filter), ...rest),
    deleteMany: (filter, ...rest) => Model.deleteMany(withFilter(filter), ...rest),
    aggregate: (pipeline = []) =>
      Model.aggregate([{ $match: { businessId: new mongoose.Types.ObjectId(businessId) } }, ...pipeline]),
    raw: Model, // deliberate escape hatch for superadmin cross-tenant queries only
  };
};
// Middlewares/plugins/tenantGuard.js
export default function tenantGuard(schema) {
  const guardedOps = [
    "find", "findOne", "findOneAndUpdate", "findOneAndDelete",
    "updateMany", "deleteMany", "countDocuments",
  ];

  guardedOps.forEach((op) => {
    schema.pre(op, function (next) {
      const filter = this.getFilter();
      const filterKeys = Object.keys(filter);
      const isIdOnlyLookup = filterKeys.length === 1 && filterKeys[0] === "_id";

      if (filter.businessId === undefined && !isIdOnlyLookup) {
        if (filter._bypassTenantGuard) {
          delete filter._bypassTenantGuard;
          return next();
        }
        return next(
          new Error(`TenantGuard: blocked a ${op} on ${this.model.modelName} — missing businessId`)
        );
      }
      next();
    });
  });
}
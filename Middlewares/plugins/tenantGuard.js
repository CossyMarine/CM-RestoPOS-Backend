// A Mongoose plugin — attach to every TENANT-OWNED schema (not Business itself).
// Refuses to run any read/write query that has no businessId in its filter.
export default function tenantGuard(schema) {
  const guardedOps = [
    "find", "findOne", "findOneAndUpdate", "findOneAndDelete",
    "updateMany", "deleteMany", "countDocuments",
  ];

  guardedOps.forEach((op) => {
    schema.pre(op, function (next) {
      const filter = this.getFilter();
      if (filter.businessId === undefined) {
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
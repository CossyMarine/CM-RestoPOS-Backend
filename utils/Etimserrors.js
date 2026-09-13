// utils/etimsErrors.js
// Every eTIMS provider adapter is required to throw one of these (never a
// raw/unclassified error) so callers — currently just jobs/etimsJob.js,
// eventually reconciliation logic too — can rely on a predictable shape
// regardless of which provider is configured or what its underlying
// transport looked like.

export class EtimsProviderError extends Error {
  constructor(message, { classification = "temporary", providerMessage = null, cause = null } = {}) {
    super(message);
    this.name = "EtimsProviderError";
    // "temporary"    — a retry is likely to help (network blip, 5xx, timeout)
    // "permanent"    — the provider understood and rejected this exact
    //                  submission; retrying the identical payload won't help
    // "configuration"— this business's eTIMS setup itself is incomplete/
    //                  disabled/unknown provider — not a per-invoice problem
    this.classification = classification;
    this.providerMessage = providerMessage; // raw provider response, if any, for debugging/audit
    if (cause) this.cause = cause;
  }
}

export class EtimsTemporaryError extends EtimsProviderError {
  constructor(message, opts = {}) {
    super(message, { ...opts, classification: "temporary" });
    this.name = "EtimsTemporaryError";
  }
}

export class EtimsPermanentError extends EtimsProviderError {
  constructor(message, opts = {}) {
    super(message, { ...opts, classification: "permanent" });
    this.name = "EtimsPermanentError";
  }
}

export class EtimsConfigurationError extends EtimsProviderError {
  constructor(message, opts = {}) {
    super(message, { ...opts, classification: "configuration" });
    this.name = "EtimsConfigurationError";
  }
}
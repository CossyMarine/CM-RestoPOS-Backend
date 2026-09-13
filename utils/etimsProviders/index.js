// utils/etimsProviders/index.js
// Maps an EtimsConfig.provider slug to its adapter implementation. Adding
// a new integrator means adding one line here plus its own adapter file —
// eTIMSService, the Agenda job, controllers, and Receipt never need to
// change to support a new provider.
import genericHttpProvider from "./genericHttpProvider.js";
import { EtimsConfigurationError } from "../etimsErrors.js";

const PROVIDERS = {
  "generic-http": genericHttpProvider,
  // "provider-a": providerAAdapter,
  // "provider-b": providerBAdapter,
};

export function getProviderAdapter(providerSlug) {
  const adapter = PROVIDERS[providerSlug];
  if (!adapter) {
    throw new EtimsConfigurationError(`No eTIMS provider adapter registered for "${providerSlug}"`);
  }
  return adapter;
}
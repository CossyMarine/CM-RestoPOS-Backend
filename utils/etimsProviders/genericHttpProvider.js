// utils/etimsProviders/genericHttpProvider.js
// This is the previous utils/etims.js placeholder implementation, relocated
// behind the provider adapter contract — NOT a new integration. Same
// payload shape, same 10s timeout, same "TODO: real endpoint/auth" markers
// as before. Still does not connect to a real KRA/integrator API; swap the
// request/response handling below once a real integration spec exists,
// without anything outside this file needing to change.
//
// Adapter contract every provider module must satisfy:
//   { submitInvoice({ invoice, credentials, deviceInfo }) => Promise<{ invoiceNumber, raw }> }
//
//   invoice     — provider-neutral invoice data built by eTIMSService
//                 (see utils/etimsService.js). Same shape regardless of
//                 which adapter receives it.
//   credentials — this business's decrypted EtimsConfig.credentials blob.
//                 Shape is entirely up to whatever this adapter's provider
//                 needs — this adapter expects { apiUrl, apiKey }.
//   deviceInfo  — this business's EtimsConfig.deviceInfo blob, as-is.
//
//   Must throw EtimsTemporaryError / EtimsPermanentError /
//   EtimsConfigurationError on failure — never a raw axios/network error —
//   so callers can rely on a predictable shape.
import axios from "axios";
import { EtimsConfigurationError, EtimsTemporaryError, EtimsPermanentError } from "../etimsErrors.js";
export default {
  async submitInvoice({ invoice, credentials, deviceInfo }) {
    const apiUrl = credentials?.apiUrl || deviceInfo?.apiUrl;
    const apiKey = credentials?.apiKey;

    if (!apiUrl || !apiKey) {
      throw new EtimsConfigurationError(
        "This business's eTIMS credentials are incomplete — missing apiUrl/apiKey"
      );
    }

    // Same field names/shape as the original utils/etims.js payload.
    const payload = {
      invoiceNumber: invoice.invoiceNumber,
      taxPin: invoice.taxPin,
      items: invoice.items,
      totalAmount: invoice.totalAmount,
      taxAmount: invoice.taxAmount,
      timestamp: invoice.timestamp,
    };

    let response;
    try {
      response = await axios.post(apiUrl, payload, {
        headers: { Authorization: `Bearer ${apiKey}` }, // TODO: real auth scheme
        timeout: 10000, // never let a slow provider hang a job indefinitely
      });
    } catch (error) {
      if (!error.response) {
        // Network failure, DNS failure, timeout — no HTTP response at all.
        // Worth retrying.
        throw new EtimsTemporaryError(`Could not reach eTIMS provider: ${error.message}`, {
          cause: error,
        });
      }

      const status = error.response.status;
      if (status >= 500) {
        throw new EtimsTemporaryError(`eTIMS provider server error (${status})`, {
          providerMessage: error.response.data,
          cause: error,
        });
      }

      // 4xx — the provider received and understood the request, and
      // rejected THIS invoice specifically. Retrying the identical payload
      // will not change the outcome.
      throw new EtimsPermanentError(`eTIMS provider rejected the invoice (${status})`, {
        providerMessage: error.response.data,
        cause: error,
      });
    }

    const data = response.data; // expect something like { invoiceNumber: "..." } — adjust once real response shape is known
    return {
      invoiceNumber: data?.invoiceNumber || null,
      raw: data,
    };
  },
};
/**
 * afta-cloudflare-worker
 *
 * Drop-in middleware for Cloudflare Workers that turns a paid handler
 * into an AFTA-compliant premium endpoint with one wrapper call.
 *
 *   - Validates the bearer against the federation host
 *   - Runs your handler
 *   - Checks staleness against the published freshness SLA
 *   - Commits the deferred debit on the host's credit ledger
 *   - Signs an Ed25519 receipt over the canonical-JSON form
 *   - Returns the wrapped response with receipt + billing block
 *
 * Honors the four AFTA no-charge guarantees automatically: 5xx,
 * circuit_breaker, schema_validation_failure (via .validationFailure()),
 * and stale_data.
 *
 * See README.md for a 30-line integration example.
 */

export { createPremiumHandler } from "./premium.js";
export { createFederationClient } from "./federation.js";
export type {
  AftaWorkerConfig,
  PremiumCallArgs,
  PremiumValidationFailureArgs,
} from "./types.js";
export type {
  FederationClient,
  ValidateResponse,
  CommitResponse,
} from "./federation.js";
export type { AftaPremiumHandler } from "./premium.js";

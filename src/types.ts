import type { FreshnessRegistry } from "afta-protocol";

/**
 * Configuration for a Cloudflare Worker AFTA harness. Pass this to
 * {@link createPremiumHandler} once at module load; reuse the resulting
 * function across every premium endpoint in your Worker.
 */
export interface AftaWorkerConfig {
  /**
   * URL of the federation host's validate endpoint, e.g.
   * `https://tensorfeed.ai/api/internal/validate`. Must accept POST with
   * { token, cost } and return { ok, credits_remaining, sufficient }.
   */
  validateUrl: string;
  /**
   * URL of the federation host's commit endpoint, e.g.
   * `https://tensorfeed.ai/api/internal/commit`. Must accept POST with
   * { token, cost, endpoint, no_charge_reason? } and return
   * { ok, credits_charged, balance_after, no_charge_reason }.
   */
  commitUrl: string;
  /**
   * Constant-time-compared shared secret sent as `X-Internal-Auth` to the
   * validate / commit endpoints. The federation host holds the same value.
   */
  sharedSecret: string;
  /**
   * Ed25519 private JWK as a JSON string. Used to sign every receipt.
   * Generate with `npx afta-generate-key` and store as a Wrangler secret.
   * If undefined / unparseable, receipts are NOT signed; AFTA degrades
   * gracefully (the response still returns, but without a receipt block).
   */
  signingKeyJwk: string | undefined;
  /** Where the publisher documents how to verify receipts. */
  verifyDoc: string;
  /**
   * Per-endpoint freshness SLA registry. Used by the staleness check
   * after the handler runs.
   */
  freshnessRegistry: FreshnessRegistry;
  /**
   * Optional prefix prepended to the endpoint string sent to the host's
   * commit endpoint, e.g. `"vrorg:"` so the host's no-charge ledger
   * shows `vrorg:/api/premium/news/search` instead of just the path.
   * Useful when one host ledger serves multiple federation members.
   */
  endpointPrefix?: string;
  /**
   * Source label put into 5xx error envelopes. Defaults to `"afta-premium"`.
   */
  sourceLabel?: string;
  /**
   * Override CORS headers. By default the wrapper emits permissive CORS
   * (Access-Control-Allow-Origin: *) since agents call from anywhere.
   */
  corsHeaders?: Record<string, string>;
  /**
   * Override the fetch timeout for federation calls in milliseconds.
   * Default 8000.
   */
  fetchTimeoutMs?: number;
}

/**
 * Per-call arguments passed to the premium handler at the call site.
 */
export interface PremiumCallArgs<T> {
  request: Request;
  /** Path the call is for, e.g. "/api/premium/news/search". */
  endpoint: string;
  /** Cost in credits. The credit ledger is on the federation host. */
  cost: number;
  /**
   * The handler. Should return the body to be returned to the agent.
   * If the body has a `captured_at` (or `generated_at`) ISO string, the
   * staleness check uses it.
   * Throwing maps to no_charge_reason: "5xx".
   */
  handler: () => Promise<T & {
    captured_at?: string;
    generated_at?: string;
  }>;
}

/**
 * Args for {@link premiumValidationFailure}.
 */
export interface PremiumValidationFailureArgs {
  request: Request;
  endpoint: string;
  cost: number;
  message: string;
}

/**
 * Premium endpoint wrapper.
 *
 * Single composable function that takes a config at module load + per-call
 * args at the call site. Inside, it does the full AFTA dance:
 *
 *   1. Extract bearer token
 *   2. Validate against the federation host
 *   3. Run the handler
 *   4. Staleness check against the published SLA
 *   5. Commit on the host (with no_charge_reason if applicable)
 *   6. Sign an Ed25519 receipt
 *   7. Return the response with the receipt embedded
 *
 * Errors thrown from the handler map to no_charge_reason: "5xx" so the
 * agent is never billed for our exceptions. Commit failures after the
 * handler ran fall back to no_charge_reason: "circuit_breaker" for the
 * same reason.
 */

import {
  checkStaleness,
  generateReceiptId,
  hashRequest,
  hashResponse,
  loadSigningKey,
  resolveSLA,
  signReceipt,
  tokenShort,
  type NoChargeReason,
  type ReceiptCore,
} from "afta-protocol";
import { createFederationClient, type FederationClient } from "./federation.js";
import type {
  AftaWorkerConfig,
  PremiumCallArgs,
  PremiumValidationFailureArgs,
} from "./types.js";

const DEFAULT_CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

function extractToken(req: Request): string {
  const auth = req.headers.get("authorization") || "";
  const m = auth.match(/^Bearer\s+(\S+)$/i);
  return m ? m[1] : "";
}

function paymentRequiredResponse(
  reason: string,
  endpoint: string,
  cors: Record<string, string>,
): Response {
  return new Response(
    JSON.stringify({
      error: "payment_required",
      reason,
      endpoint,
    }),
    {
      status: 402,
      headers: {
        ...cors,
        "Content-Type": "application/json",
        "WWW-Authenticate": 'Bearer realm="afta-premium"',
      },
    },
  );
}

interface SigningContext {
  jwkString: string | undefined;
  verifyDoc: string;
  loaded: { key: CryptoKey; kid: string } | null;
  loadedFor: string | undefined;
}

async function getSigningKey(ctx: SigningContext) {
  if (!ctx.jwkString) return null;
  if (ctx.loaded && ctx.loadedFor === ctx.jwkString) return ctx.loaded;
  ctx.loaded = await loadSigningKey(ctx.jwkString);
  ctx.loadedFor = ctx.jwkString;
  return ctx.loaded;
}

export interface AftaPremiumHandler {
  /**
   * The wrapper. Call from your Worker's fetch handler.
   */
  <T extends Record<string, unknown>>(args: PremiumCallArgs<T>): Promise<Response>;
  /**
   * Helper for early HTTP 400 schema-validation failures. Logs no-charge
   * via commit, signs a receipt with credits_charged: 0, returns 400.
   */
  validationFailure(args: PremiumValidationFailureArgs): Promise<Response>;
  /**
   * CORS preflight helper.
   */
  preflight(): Response;
  /** Federation client, exposed for read-only diagnostics. */
  federation: FederationClient;
}

/**
 * Build a premium handler. Call this once at Worker module load and
 * reuse the returned function across every premium endpoint.
 */
export function createPremiumHandler(
  config: AftaWorkerConfig,
): AftaPremiumHandler {
  const federation = createFederationClient({
    validateUrl: config.validateUrl,
    commitUrl: config.commitUrl,
    sharedSecret: config.sharedSecret,
    fetchTimeoutMs: config.fetchTimeoutMs,
  });
  const cors = { ...DEFAULT_CORS, ...(config.corsHeaders ?? {}) };
  const sourceLabel = config.sourceLabel ?? "afta-premium";
  const endpointPrefix = config.endpointPrefix ?? "";
  const signingCtx: SigningContext = {
    jwkString: config.signingKeyJwk,
    verifyDoc: config.verifyDoc,
    loaded: null,
    loadedFor: undefined,
  };

  async function buildAndSignReceipt(
    request: Request,
    endpoint: string,
    bodyResult: Record<string, unknown>,
    receiptCapturedAt: string | null,
    creditsCharged: number,
    creditsRemaining: number,
    token: string,
    noChargeReason: NoChargeReason,
  ) {
    const url = new URL(request.url);
    const requestHash = await hashRequest(request.method, url);
    const responseHash = await hashResponse(bodyResult);
    const sla = resolveSLA(config.freshnessRegistry, endpoint);
    const core: ReceiptCore = {
      v: 1,
      id: generateReceiptId(),
      endpoint,
      method: request.method,
      token_short: tokenShort(token),
      credits_charged: creditsCharged,
      credits_remaining: creditsRemaining,
      request_hash: requestHash,
      response_hash: responseHash,
      captured_at: receiptCapturedAt,
      server_time: new Date().toISOString(),
      no_charge_reason: noChargeReason,
      freshness_sla_seconds: sla?.maxAgeSeconds ?? null,
    };
    const key = await getSigningKey(signingCtx);
    if (!key) return null;
    return await signReceipt({
      core,
      signingKey: key,
      verifyDoc: config.verifyDoc,
    });
  }

  async function premium<T extends Record<string, unknown>>(
    args: PremiumCallArgs<T>,
  ): Promise<Response> {
    const { request, endpoint, cost, handler } = args;
    const token = extractToken(request);
    if (!token) return paymentRequiredResponse("missing_bearer", endpoint, cors);

    const validate = await federation.validate(token, cost);
    if (!validate.ok) {
      return paymentRequiredResponse(
        validate.reason ?? "validate_failed",
        endpoint,
        cors,
      );
    }
    if (!validate.sufficient) {
      return paymentRequiredResponse(
        "insufficient_credits",
        endpoint,
        cors,
      );
    }
    const currentBalance =
      typeof validate.credits_remaining === "number"
        ? validate.credits_remaining
        : 0;

    let bodyResult: Record<string, unknown>;
    let noChargeReason: NoChargeReason = null;
    let httpStatus = 200;
    try {
      const result = await handler();
      bodyResult = { ...result };
      const capturedAt =
        typeof bodyResult.captured_at === "string"
          ? bodyResult.captured_at
          : typeof bodyResult.generated_at === "string"
            ? bodyResult.generated_at
            : null;
      const staleness = checkStaleness(
        config.freshnessRegistry,
        endpoint,
        capturedAt,
        new Date(),
      );
      if (staleness.applies && staleness.stale) {
        noChargeReason = "stale_data";
        bodyResult.stale = true;
        bodyResult.stale_age_seconds = staleness.ageSeconds;
        bodyResult.stale_sla_seconds = staleness.slaSeconds;
      }
    } catch (err) {
      console.error(`afta-premium ${endpoint}: handler threw`, err);
      noChargeReason = "5xx";
      httpStatus = 500;
      bodyResult = {
        source: sourceLabel,
        endpoint,
        generated_at: new Date().toISOString(),
        error: "upstream_error",
        message:
          "Handler caught an exception. No credit was charged for this call. Retry shortly.",
      };
    }

    const commitEndpoint = endpointPrefix + endpoint;
    const commit = await federation.commit(
      token,
      cost,
      commitEndpoint,
      noChargeReason,
    );
    let creditsCharged: number;
    let creditsRemaining: number;
    if (commit.ok) {
      creditsCharged =
        typeof commit.credits_charged === "number"
          ? commit.credits_charged
          : noChargeReason
            ? 0
            : cost;
      creditsRemaining =
        typeof commit.balance_after === "number"
          ? commit.balance_after
          : currentBalance - (noChargeReason ? 0 : cost);
    } else {
      noChargeReason = noChargeReason ?? "circuit_breaker";
      creditsCharged = 0;
      creditsRemaining = currentBalance;
    }

    const receiptCapturedAt =
      typeof bodyResult.captured_at === "string"
        ? bodyResult.captured_at
        : typeof bodyResult.generated_at === "string"
          ? bodyResult.generated_at
          : null;

    const receipt = await buildAndSignReceipt(
      request,
      endpoint,
      bodyResult,
      receiptCapturedAt,
      creditsCharged,
      creditsRemaining,
      token,
      noChargeReason,
    );

    return new Response(
      JSON.stringify({
        ...bodyResult,
        receipt,
        billing: {
          credits_charged: creditsCharged,
          credits_remaining: creditsRemaining,
          no_charge_reason: noChargeReason,
        },
      }),
      {
        status: httpStatus,
        headers: { ...cors, "Content-Type": "application/json" },
      },
    );
  }

  async function validationFailure(
    args: PremiumValidationFailureArgs,
  ): Promise<Response> {
    const { request, endpoint, cost, message } = args;
    const token = extractToken(request);
    if (!token) return paymentRequiredResponse("missing_bearer", endpoint, cors);

    const noChargeReason: NoChargeReason = "schema_validation_failure";
    const commitEndpoint = endpointPrefix + endpoint;
    const commit = await federation.commit(
      token,
      cost,
      commitEndpoint,
      noChargeReason,
    );
    const creditsRemaining =
      commit.ok && typeof commit.balance_after === "number"
        ? commit.balance_after
        : 0;

    const bodyResult: Record<string, unknown> = {
      source: sourceLabel,
      endpoint,
      generated_at: new Date().toISOString(),
      error: "schema_validation_failure",
      message,
    };

    const receipt = await buildAndSignReceipt(
      request,
      endpoint,
      bodyResult,
      null,
      0,
      creditsRemaining,
      token,
      noChargeReason,
    );

    return new Response(
      JSON.stringify({
        ...bodyResult,
        receipt,
        billing: {
          credits_charged: 0,
          credits_remaining: creditsRemaining,
          no_charge_reason: noChargeReason,
        },
      }),
      {
        status: 400,
        headers: { ...cors, "Content-Type": "application/json" },
      },
    );
  }

  function preflight(): Response {
    return new Response(null, { status: 204, headers: cors });
  }

  const handler = premium as unknown as AftaPremiumHandler;
  handler.validationFailure = validationFailure;
  handler.preflight = preflight;
  handler.federation = federation;
  return handler;
}

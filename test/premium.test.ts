import { describe, it, expect, beforeEach, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { createPremiumHandler } from "../src/index";
import type { AftaWorkerConfig } from "../src/index";

if (typeof globalThis.crypto === "undefined") {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).crypto = webcrypto;
}

const VALIDATE_URL = "https://host.example/api/internal/validate";
const COMMIT_URL = "https://host.example/api/internal/commit";

let signingKeyJwk: string;

beforeEach(async () => {
  const { privateKey } = await webcrypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  );
  const priv = await webcrypto.subtle.exportKey("jwk", privateKey);
  signingKeyJwk = JSON.stringify(priv);
});

function configWith(overrides: Partial<AftaWorkerConfig> = {}): AftaWorkerConfig {
  return {
    validateUrl: VALIDATE_URL,
    commitUrl: COMMIT_URL,
    sharedSecret: "test-secret",
    signingKeyJwk,
    verifyDoc: "https://example.com/agent-fair-trade#receipts",
    freshnessRegistry: {
      "/api/premium/test": { maxAgeSeconds: 1800 },
    },
    ...overrides,
  };
}

function makeRequest(
  path: string,
  init: RequestInit & { bearer?: string } = {},
): Request {
  const headers = new Headers(init.headers);
  if (init.bearer) headers.set("Authorization", `Bearer ${init.bearer}`);
  return new Request(`https://yoursite.example${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body,
  });
}

interface MockResponse {
  status: number;
  body: unknown;
}

function mockFetch(
  routes: Record<string, (body: unknown) => MockResponse>,
): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const route = routes[url];
      if (!route) {
        return new Response("not stubbed", { status: 599 });
      }
      const reqBody = init.body ? JSON.parse(init.body as string) : null;
      const out = route(reqBody);
      return new Response(JSON.stringify(out.body), {
        status: out.status,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
}

describe("createPremiumHandler", () => {
  it("returns 402 when no bearer is present", async () => {
    mockFetch({});
    const handler = createPremiumHandler(configWith());
    const res = await handler({
      request: makeRequest("/api/premium/test"),
      endpoint: "/api/premium/test",
      cost: 1,
      handler: async () => ({ data: 1 }),
    });
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: string; reason: string };
    expect(body.error).toBe("payment_required");
    expect(body.reason).toBe("missing_bearer");
  });

  it("returns 402 when validate says insufficient_credits", async () => {
    mockFetch({
      [VALIDATE_URL]: () => ({
        status: 200,
        body: { ok: true, sufficient: false, credits_remaining: 0 },
      }),
    });
    const handler = createPremiumHandler(configWith());
    const res = await handler({
      request: makeRequest("/api/premium/test", { bearer: "tk_abc" }),
      endpoint: "/api/premium/test",
      cost: 1,
      handler: async () => ({ data: 1 }),
    });
    expect(res.status).toBe(402);
    const body = (await res.json()) as { reason: string };
    expect(body.reason).toBe("insufficient_credits");
  });

  it("happy path: validates, runs handler, commits, signs receipt", async () => {
    let validateCalled = false;
    let commitCalled = false;
    mockFetch({
      [VALIDATE_URL]: () => {
        validateCalled = true;
        return {
          status: 200,
          body: { ok: true, sufficient: true, credits_remaining: 100 },
        };
      },
      [COMMIT_URL]: (body) => {
        commitCalled = true;
        const b = body as { cost: number; no_charge_reason: string | null };
        return {
          status: 200,
          body: {
            ok: true,
            credits_charged: b.cost,
            balance_after: 100 - b.cost,
            no_charge_reason: b.no_charge_reason,
          },
        };
      },
    });
    const handler = createPremiumHandler(configWith());
    const res = await handler({
      request: makeRequest("/api/premium/test", { bearer: "tk_abc" }),
      endpoint: "/api/premium/test",
      cost: 5,
      handler: async () => ({
        results: [1, 2],
        captured_at: new Date().toISOString(),
      }),
    });
    expect(validateCalled).toBe(true);
    expect(commitCalled).toBe(true);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      receipt: { signature: string; signing_alg: string };
      billing: { credits_charged: number; credits_remaining: number; no_charge_reason: null };
      results: number[];
    };
    expect(body.results).toEqual([1, 2]);
    expect(body.billing.credits_charged).toBe(5);
    expect(body.billing.credits_remaining).toBe(95);
    expect(body.billing.no_charge_reason).toBeNull();
    expect(body.receipt.signing_alg).toBe("EdDSA");
    expect(body.receipt.signature).toBeTruthy();
  });

  it("handler throws -> 500 with no_charge_reason: 5xx, credits_charged: 0", async () => {
    mockFetch({
      [VALIDATE_URL]: () => ({
        status: 200,
        body: { ok: true, sufficient: true, credits_remaining: 100 },
      }),
      [COMMIT_URL]: (body) => {
        const b = body as { no_charge_reason: string };
        return {
          status: 200,
          body: {
            ok: true,
            credits_charged: 0,
            balance_after: 100,
            no_charge_reason: b.no_charge_reason,
          },
        };
      },
    });
    // suppress expected console.error
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const handler = createPremiumHandler(configWith());
    const res = await handler({
      request: makeRequest("/api/premium/test", { bearer: "tk_abc" }),
      endpoint: "/api/premium/test",
      cost: 5,
      handler: async () => {
        throw new Error("boom");
      },
    });
    errSpy.mockRestore();
    expect(res.status).toBe(500);
    const body = (await res.json()) as {
      billing: { credits_charged: number; no_charge_reason: string };
      error: string;
    };
    expect(body.billing.credits_charged).toBe(0);
    expect(body.billing.no_charge_reason).toBe("5xx");
    expect(body.error).toBe("upstream_error");
  });

  it("stale data -> stale_data no-charge with stale: true in body", async () => {
    mockFetch({
      [VALIDATE_URL]: () => ({
        status: 200,
        body: { ok: true, sufficient: true, credits_remaining: 100 },
      }),
      [COMMIT_URL]: (body) => {
        const b = body as { no_charge_reason: string };
        return {
          status: 200,
          body: {
            ok: true,
            credits_charged: 0,
            balance_after: 100,
            no_charge_reason: b.no_charge_reason,
          },
        };
      },
    });
    const config = configWith({
      freshnessRegistry: {
        "/api/premium/test": { maxAgeSeconds: 1800 }, // 30 min
      },
    });
    const handler = createPremiumHandler(config);
    const ancient = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2h old
    const res = await handler({
      request: makeRequest("/api/premium/test", { bearer: "tk_abc" }),
      endpoint: "/api/premium/test",
      cost: 5,
      handler: async () => ({ data: 1, captured_at: ancient }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      billing: { credits_charged: number; no_charge_reason: string };
      stale: boolean;
      stale_age_seconds: number;
    };
    expect(body.stale).toBe(true);
    expect(body.billing.no_charge_reason).toBe("stale_data");
    expect(body.billing.credits_charged).toBe(0);
    expect(body.stale_age_seconds).toBeGreaterThan(1800);
  });

  it("commit fails after handler -> circuit_breaker no-charge", async () => {
    mockFetch({
      [VALIDATE_URL]: () => ({
        status: 200,
        body: { ok: true, sufficient: true, credits_remaining: 100 },
      }),
      [COMMIT_URL]: () => ({
        status: 500,
        body: { error: "host down" },
      }),
    });
    const handler = createPremiumHandler(configWith());
    const res = await handler({
      request: makeRequest("/api/premium/test", { bearer: "tk_abc" }),
      endpoint: "/api/premium/test",
      cost: 5,
      handler: async () => ({ data: 1, captured_at: new Date().toISOString() }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      billing: { credits_charged: number; no_charge_reason: string };
    };
    expect(body.billing.credits_charged).toBe(0);
    expect(body.billing.no_charge_reason).toBe("circuit_breaker");
  });

  it("validationFailure: 400 with signed receipt, credits_charged: 0", async () => {
    mockFetch({
      [COMMIT_URL]: (body) => {
        const b = body as { no_charge_reason: string };
        return {
          status: 200,
          body: {
            ok: true,
            credits_charged: 0,
            balance_after: 100,
            no_charge_reason: b.no_charge_reason,
          },
        };
      },
    });
    const handler = createPremiumHandler(configWith());
    const res = await handler.validationFailure({
      request: makeRequest("/api/premium/test", { bearer: "tk_abc" }),
      endpoint: "/api/premium/test",
      cost: 5,
      message: "missing required q parameter",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: string;
      message: string;
      billing: { no_charge_reason: string; credits_charged: number };
      receipt: { signing_alg: string };
    };
    expect(body.error).toBe("schema_validation_failure");
    expect(body.message).toBe("missing required q parameter");
    expect(body.billing.no_charge_reason).toBe("schema_validation_failure");
    expect(body.billing.credits_charged).toBe(0);
    expect(body.receipt.signing_alg).toBe("EdDSA");
  });

  it("preflight: 204 with CORS headers", () => {
    const handler = createPremiumHandler(configWith());
    const res = handler.preflight();
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("GET");
  });

  it("endpointPrefix: prepended to commit endpoint", async () => {
    let committedEndpoint = "";
    mockFetch({
      [VALIDATE_URL]: () => ({
        status: 200,
        body: { ok: true, sufficient: true, credits_remaining: 100 },
      }),
      [COMMIT_URL]: (body) => {
        const b = body as { endpoint: string };
        committedEndpoint = b.endpoint;
        return {
          status: 200,
          body: {
            ok: true,
            credits_charged: 5,
            balance_after: 95,
            no_charge_reason: null,
          },
        };
      },
    });
    const handler = createPremiumHandler(
      configWith({ endpointPrefix: "vrorg:" }),
    );
    await handler({
      request: makeRequest("/api/premium/test", { bearer: "tk_abc" }),
      endpoint: "/api/premium/test",
      cost: 5,
      handler: async () => ({ data: 1, captured_at: new Date().toISOString() }),
    });
    expect(committedEndpoint).toBe("vrorg:/api/premium/test");
  });

  it("graceful degradation: receipt is null when signing key is unset", async () => {
    mockFetch({
      [VALIDATE_URL]: () => ({
        status: 200,
        body: { ok: true, sufficient: true, credits_remaining: 100 },
      }),
      [COMMIT_URL]: () => ({
        status: 200,
        body: { ok: true, credits_charged: 5, balance_after: 95, no_charge_reason: null },
      }),
    });
    const handler = createPremiumHandler(
      configWith({ signingKeyJwk: undefined }),
    );
    const res = await handler({
      request: makeRequest("/api/premium/test", { bearer: "tk_abc" }),
      endpoint: "/api/premium/test",
      cost: 5,
      handler: async () => ({ data: 1, captured_at: new Date().toISOString() }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { receipt: unknown; billing: { credits_charged: number } };
    expect(body.receipt).toBeNull();
    expect(body.billing.credits_charged).toBe(5);
  });

  // ── Reservation flow (post-2026-05-05 atomic-reserve federation) ──
  //
  // Verifies that when a host worker returns reservation_id from
  // validate, the commit call threads it back. Closes the federation
  // double-spend race that motivated the host-side patch (TF commit
  // a1883df, 2026-05-05).

  it("threads reservation_id from validate response into commit body", async () => {
    let observedCommitBody: { reservation_id?: string } | null = null;
    mockFetch({
      [VALIDATE_URL]: () => ({
        status: 200,
        body: {
          ok: true,
          sufficient: true,
          credits_remaining: 99,
          reservation_id: "tf-reservation-abc123",
        },
      }),
      [COMMIT_URL]: (body) => {
        observedCommitBody = body as { reservation_id?: string };
        return {
          status: 200,
          body: { ok: true, credits_charged: 1, balance_after: 99, no_charge_reason: null },
        };
      },
    });
    const handler = createPremiumHandler(configWith());
    const res = await handler({
      request: makeRequest("/api/premium/test", { bearer: "tk_abc" }),
      endpoint: "/api/premium/test",
      cost: 1,
      handler: async () => ({ ok: true, captured_at: new Date().toISOString() }),
    });
    expect(res.status).toBe(200);
    expect(observedCommitBody).not.toBeNull();
    expect(observedCommitBody!.reservation_id).toBe("tf-reservation-abc123");
  });

  it("omits reservation_id from commit body when validate did not return one (legacy host)", async () => {
    let observedCommitBody: Record<string, unknown> | null = null;
    mockFetch({
      [VALIDATE_URL]: () => ({
        status: 200,
        body: { ok: true, sufficient: true, credits_remaining: 50 },
      }),
      [COMMIT_URL]: (body) => {
        observedCommitBody = body as Record<string, unknown>;
        return {
          status: 200,
          body: { ok: true, credits_charged: 1, balance_after: 49, no_charge_reason: null },
        };
      },
    });
    const handler = createPremiumHandler(configWith());
    await handler({
      request: makeRequest("/api/premium/test", { bearer: "tk_abc" }),
      endpoint: "/api/premium/test",
      cost: 1,
      handler: async () => ({ ok: true, captured_at: new Date().toISOString() }),
    });
    expect(observedCommitBody).not.toBeNull();
    expect("reservation_id" in observedCommitBody!).toBe(false);
  });

  it("logs a warning and falls back to no_charge_reason on reservation_not_found", async () => {
    mockFetch({
      [VALIDATE_URL]: () => ({
        status: 200,
        body: {
          ok: true,
          sufficient: true,
          credits_remaining: 99,
          reservation_id: "tf-reservation-expired",
        },
      }),
      [COMMIT_URL]: () => ({
        status: 200,
        body: { ok: false, reason: "reservation_not_found" },
      }),
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const handler = createPremiumHandler(configWith());
    const res = await handler({
      request: makeRequest("/api/premium/test", { bearer: "tk_abc" }),
      endpoint: "/api/premium/test",
      cost: 1,
      handler: async () => ({ ok: true, captured_at: new Date().toISOString() }),
    });
    warnSpy.mockRestore();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { billing: { credits_charged: number; no_charge_reason: string } };
    // Defensive fallback: when commit fails but the handler succeeded,
    // the wrapper records circuit_breaker as the no-charge reason so
    // the agent is not billed.
    expect(body.billing.credits_charged).toBe(0);
    expect(body.billing.no_charge_reason).toBe("circuit_breaker");
  });

  it("validationFailure path commits without reservation_id (no validate ran)", async () => {
    let observedCommitBody: Record<string, unknown> | null = null;
    mockFetch({
      [COMMIT_URL]: (body) => {
        observedCommitBody = body as Record<string, unknown>;
        return {
          status: 200,
          body: { ok: true, credits_charged: 0, balance_after: 99, no_charge_reason: "schema_validation_failure" },
        };
      },
    });
    const handler = createPremiumHandler(configWith());
    const res = await handler.validationFailure({
      request: makeRequest("/api/premium/test", { bearer: "tk_abc" }),
      endpoint: "/api/premium/test",
      cost: 1,
      message: "missing required parameter `task`",
    });
    expect(res.status).toBe(400);
    expect(observedCommitBody).not.toBeNull();
    // No validate happens before validationFailure, so no reservation
    // exists to thread through. The host's legacy commit path handles
    // standalone schema-validation no-charge events without a
    // reservation; this is correct.
    expect("reservation_id" in observedCommitBody!).toBe(false);
    expect(observedCommitBody!.no_charge_reason).toBe("schema_validation_failure");
  });
});

/**
 * Minimal AFTA-compliant Cloudflare Worker.
 *
 * One free endpoint, one paid endpoint, one schema-validation example.
 * About 60 lines of glue code total. Drop into a Wrangler project as
 * src/index.ts.
 *
 * Required Wrangler secrets:
 *   wrangler secret put SHARED_INTERNAL_SECRET
 *   wrangler secret put RECEIPT_PRIVATE_KEY_JWK
 */

import { createPremiumHandler } from "afta-cloudflare-worker";

interface Env {
  SHARED_INTERNAL_SECRET: string;
  RECEIPT_PRIVATE_KEY_JWK: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Build the premium handler once per cold start. It's a closure over
    // env, so credentials never leak into module scope.
    const premium = createPremiumHandler({
      validateUrl: "https://tensorfeed.ai/api/internal/validate",
      commitUrl: "https://tensorfeed.ai/api/internal/commit",
      sharedSecret: env.SHARED_INTERNAL_SECRET,
      signingKeyJwk: env.RECEIPT_PRIVATE_KEY_JWK,
      verifyDoc: "https://yoursite.example/agent-fair-trade#receipts",
      freshnessRegistry: {
        "/api/premium/echo": { maxAgeSeconds: 60 },
      },
      endpointPrefix: "yoursite:",
    });

    if (request.method === "OPTIONS") return premium.preflight();

    // Free endpoint: open to any agent.
    if (url.pathname === "/api/health") {
      return Response.json({ ok: true, time: new Date().toISOString() });
    }

    // Paid endpoint: 1 credit, 60s freshness SLA.
    if (url.pathname === "/api/premium/echo") {
      const message = url.searchParams.get("m") || "";
      if (!message) {
        return premium.validationFailure({
          request,
          endpoint: url.pathname,
          cost: 1,
          message: "Missing required parameter: m (the string to echo)",
        });
      }

      return premium({
        request,
        endpoint: url.pathname,
        cost: 1,
        handler: async () => ({
          echoed: message,
          captured_at: new Date().toISOString(),
        }),
      });
    }

    return new Response("Not found", { status: 404 });
  },
};

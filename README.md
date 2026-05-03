# afta-cloudflare-worker

Drop-in middleware for Cloudflare Workers that turns a paid handler into an [AFTA](https://github.com/RipperMercs/afta)-compliant premium endpoint with one wrapper call.

```bash
npm install afta-cloudflare-worker afta-protocol
```

What you get for free per endpoint:

- HTTP 402 with proper `WWW-Authenticate` when no bearer is present
- Bearer validation against your federation host's `/api/internal/validate`
- Your handler runs
- Staleness check against your published freshness SLA (auto no-charge if data is older than the SLA)
- Commit on the host's credit ledger via `/api/internal/commit`
- Ed25519-signed receipt over the canonical-JSON form
- Response wrapped with `receipt` + `billing` blocks

All four AFTA no-charge guarantees are enforced automatically: `5xx`, `circuit_breaker`, `schema_validation_failure`, `stale_data`.

## Quick start

```ts
import { createPremiumHandler } from "afta-cloudflare-worker";

interface Env {
  SHARED_INTERNAL_SECRET: string;
  RECEIPT_PRIVATE_KEY_JWK: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    const premium = createPremiumHandler({
      validateUrl: "https://tensorfeed.ai/api/internal/validate",
      commitUrl: "https://tensorfeed.ai/api/internal/commit",
      sharedSecret: env.SHARED_INTERNAL_SECRET,
      signingKeyJwk: env.RECEIPT_PRIVATE_KEY_JWK,
      verifyDoc: "https://yoursite.example/agent-fair-trade#receipts",
      freshnessRegistry: {
        "/api/premium/news/search": { maxAgeSeconds: 30 * 60 },
      },
      endpointPrefix: "yoursite:",
    });

    if (request.method === "OPTIONS") return premium.preflight();

    if (url.pathname === "/api/premium/news/search") {
      const q = url.searchParams.get("q") || "";
      if (q.length < 2) {
        return premium.validationFailure({
          request,
          endpoint: url.pathname,
          cost: 1,
          message: "q must be at least 2 chars",
        });
      }

      return premium({
        request,
        endpoint: url.pathname,
        cost: 1,
        handler: async () => {
          const results = await yourSearchLogic(q);
          return {
            results,
            captured_at: new Date().toISOString(),
          };
        },
      });
    }

    return new Response("Not found", { status: 404 });
  },
};

async function yourSearchLogic(q: string) {
  return [{ title: "result for " + q }];
}
```

That's the whole integration. The wrapper handles every AFTA mechanic.

## What the response looks like

Successful paid call:

```json
{
  "results": [...],
  "captured_at": "2026-05-03T00:01:23Z",
  "receipt": {
    "v": 1,
    "id": "rcpt_a1b2c3d4e5f6a7b8",
    "endpoint": "/api/premium/news/search",
    "method": "GET",
    "token_short": "tk_live_abcdef12...90abcdef",
    "credits_charged": 1,
    "credits_remaining": 99,
    "request_hash": "sha256:...",
    "response_hash": "sha256:...",
    "captured_at": "2026-05-03T00:01:23Z",
    "server_time": "2026-05-03T00:01:24Z",
    "no_charge_reason": null,
    "freshness_sla_seconds": 1800,
    "signature": "...",
    "key_id": "abc123def456",
    "signing_alg": "EdDSA",
    "signing_curve": "Ed25519",
    "canonical_form": "afta-canonical-json-v1",
    "verify_doc": "https://yoursite.example/agent-fair-trade#receipts"
  },
  "billing": {
    "credits_charged": 1,
    "credits_remaining": 99,
    "no_charge_reason": null
  }
}
```

Stale data (no charge):

```json
{
  "results": [...],
  "captured_at": "2026-05-02T22:00:00Z",
  "stale": true,
  "stale_age_seconds": 7800,
  "stale_sla_seconds": 1800,
  "receipt": { "...": "...", "no_charge_reason": "stale_data", "credits_charged": 0 },
  "billing": { "credits_charged": 0, "credits_remaining": 100, "no_charge_reason": "stale_data" }
}
```

5xx error (no charge):

```json
{
  "source": "afta-premium",
  "endpoint": "/api/premium/news/search",
  "error": "upstream_error",
  "message": "Handler caught an exception. No credit was charged for this call. Retry shortly.",
  "receipt": { "...": "...", "no_charge_reason": "5xx", "credits_charged": 0 },
  "billing": { "credits_charged": 0, "credits_remaining": 100, "no_charge_reason": "5xx" }
}
```

## Configuration

| Field | Required | Description |
| --- | --- | --- |
| `validateUrl` | yes | Federation host's POST validate endpoint URL |
| `commitUrl` | yes | Federation host's POST commit endpoint URL |
| `sharedSecret` | yes | Constant-time-compared shared secret sent as `X-Internal-Auth` |
| `signingKeyJwk` | recommended | Ed25519 private JWK as a string. If unset, receipts are not emitted (graceful degradation) |
| `verifyDoc` | yes | URL where you document how to verify your receipts |
| `freshnessRegistry` | yes | Per-endpoint SLA registry. See `afta-protocol`. |
| `endpointPrefix` | optional | Prefix for the endpoint string sent to commit. Useful when one host ledger serves multiple federation members. |
| `sourceLabel` | optional | Source label put into 5xx error envelopes. Default `"afta-premium"`. |
| `corsHeaders` | optional | Override the default CORS headers. |
| `fetchTimeoutMs` | optional | Federation fetch timeout. Default 8000ms. |

## Setting up your federation membership

You need access to a federation host that exposes `/api/internal/{validate,commit}` and shares the `X-Internal-Auth` secret with you. Currently:

- **tensorfeed.ai** hosts the first AFTA federation. Reach out via `feedback@tensorfeed.ai` to discuss joining as a federation member.
- You can also run your own host (the standard does not require a single ledger). The host responsibilities are documented in the [AFTA spec](https://tensorfeed.ai/agent-fair-trade).

Generate your receipt keypair with:

```bash
npx afta-generate-key --publisher=yoursite.example
```

Set the printed private JWK as `RECEIPT_PRIVATE_KEY_JWK`:

```bash
wrangler secret put RECEIPT_PRIVATE_KEY_JWK
```

Set the shared federation secret:

```bash
wrangler secret put SHARED_INTERNAL_SECRET
```

Commit the public JWK to your repo at `public/.well-known/<publisher>-receipt-key.json`. Reference it from your AFTA manifest's `receipts.public_key_url`.

## License

MIT.

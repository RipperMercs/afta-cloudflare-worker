# Minimal AFTA Cloudflare Worker

A working AFTA-compliant Worker in 60 lines.

## What it does

- `GET /api/health` (free) - liveness probe
- `GET /api/premium/echo?m=hello` (1 credit) - echo the `m` parameter back, AFTA-compliant
- 60-second freshness SLA on the paid endpoint - if data captured-at is older than 60s, the call goes no-charge

## Setup

```bash
npm install afta-cloudflare-worker afta-protocol
npx afta-generate-key --publisher=yoursite.example
wrangler secret put RECEIPT_PRIVATE_KEY_JWK    # paste the printed private JWK
wrangler secret put SHARED_INTERNAL_SECRET     # the federation shared secret
wrangler deploy
```

## Test it

```bash
# Free endpoint, no auth
curl https://your-worker.workers.dev/api/health

# Paid endpoint without bearer -> 402
curl -i https://your-worker.workers.dev/api/premium/echo?m=hello

# Paid endpoint with a bearer minted on the federation host
curl -H "Authorization: Bearer tf_live_..." \
     "https://your-worker.workers.dev/api/premium/echo?m=hello"

# Schema validation failure (no `m` param) -> 400 with signed receipt, 0 credits
curl -i -H "Authorization: Bearer tf_live_..." \
     "https://your-worker.workers.dev/api/premium/echo"
```

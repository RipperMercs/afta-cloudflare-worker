# AFTA Receipt Verifier

Standalone Node script showing how an agent verifies an AFTA-signed receipt end to end.

Zero npm dependencies. Uses `node:crypto` for Ed25519 verification and SHA-256 hashing. Run it as a sanity check the next time you integrate against a federation member's paid endpoints.

## Why this exists

AFTA's pitch is that every paid response carries a cryptographically signed receipt the agent can verify offline. That claim is only as strong as the verification path. This example is the verification path, written so an agent author can drop it in or read it as a spec.

Three things get checked:

1. **Ed25519 signature** over the canonical-JSON form of the receipt's core fields. Confirms the publisher (and only the publisher) issued this receipt.
2. **`response_hash`** matches a fresh canonical-JSON SHA-256 of the response body (minus the `receipt` and `billing` blocks). Confirms the body wasn't tampered with after signing.
3. **`request_hash`** matches the agent's view of the URL it called. Confirms the receipt is for the call you actually made, not a substituted one.

If all three pass, the receipt is non-forgeable proof the publisher charged (or no-charged) the call exactly as written.

## Usage

```bash
node verify.mjs <url> <bearer> [public-jwk-url]
```

Example against TensorFeed:

```bash
node verify.mjs \
  "https://tensorfeed.ai/api/premium/news/search?q=anthropic" \
  "tf_live_..." \
  "https://tensorfeed.ai/.well-known/tensorfeed-receipt-key.json"
```

If you omit `public-jwk-url` the verifier guesses `<verify_doc origin>/.well-known/receipt-key.json`. That guess works for new federation members who follow the conventional layout, but production agents should pin the URL.

## What you'll see

```
→ Calling https://tensorfeed.ai/api/premium/news/search?q=anthropic
← HTTP 200 in 412ms

Receipt fields:
  id              rcpt_a1b2c3d4e5f6a7b8
  endpoint        /api/premium/news/search
  credits_charged 1
  no_charge       (none)
  signing_alg     EdDSA
  key_id          abc123def456
  verify_doc      https://tensorfeed.ai/agent-fair-trade#receipts

→ Fetching public JWK from https://tensorfeed.ai/.well-known/tensorfeed-receipt-key.json

Verification:
  Ed25519 signature  PASS
  response_hash      PASS
  request_hash       PASS

OK: receipt is valid.
```

A `no_charge_reason` other than `null` (e.g. `stale_data`, `5xx`, `circuit_breaker`, `schema_validation_failure`) means the receipt is a no-charge proof; `credits_charged` should be `0` and the verification still confirms the publisher honored the AFTA guarantee in code.

## Storage

Production agents should persist receipts. The receipt body is small (a few hundred bytes) and lets you replay this verification at any point in the future, even if the publisher rotates keys (use `key_id` to pick the right historical public JWK).

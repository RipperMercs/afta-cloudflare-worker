#!/usr/bin/env node
/**
 * AFTA receipt verifier (agent side).
 *
 * Demonstrates the trust model that makes AFTA receipts useful:
 *
 *   1. Agent calls a paid endpoint with a bearer token
 *   2. Publisher returns the response body + a signed receipt block
 *   3. Agent fetches the publisher's public Ed25519 JWK from .well-known/
 *   4. Agent verifies the signature over the canonical-JSON form of the
 *      receipt's core fields (everything except signature, key_id,
 *      signing_alg, signing_curve, canonical_form, verify_doc)
 *   5. Agent independently recomputes response_hash over the body sans
 *      receipt + billing, confirms it matches
 *   6. Agent recomputes request_hash from the URL it just hit, confirms
 *      it matches
 *
 * If all three checks pass, the receipt is non-forgeable proof that the
 * publisher charged (or no-charged) the call exactly as recorded. Store
 * receipts; an audit later can replay this verification offline.
 *
 * Usage:
 *   node verify.mjs <url> <bearer> [public-jwk-url]
 *
 * Example:
 *   node verify.mjs \
 *     "https://api.example.com/api/premium/echo?m=hello" \
 *     "tf_live_abc..." \
 *     "https://api.example.com/.well-known/example-receipt-key.json"
 *
 * If public-jwk-url is omitted, the verifier falls back to the receipt's
 * verify_doc field, which is informational only. In a production agent,
 * pin the public JWK URL.
 */

import { webcrypto } from "node:crypto";

// ── Canonical JSON (must match the publisher's serialization exactly) ──

function canonicalJSON(value) {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("canonicalJSON: non-finite number");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJSON).join(",") + "]";
  }
  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    const parts = keys.map(
      (k) => JSON.stringify(k) + ":" + canonicalJSON(value[k]),
    );
    return "{" + parts.join(",") + "}";
  }
  throw new Error(`canonicalJSON: unsupported type ${typeof value}`);
}

// ── Helpers ──

const enc = new TextEncoder();

async function sha256Hex(input) {
  const buf = await webcrypto.subtle.digest("SHA-256", enc.encode(input));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function base64UrlToBytes(s) {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  const bin = Buffer.from(b64, "base64");
  return new Uint8Array(bin);
}

async function hashRequest(method, urlString) {
  const url = new URL(urlString);
  const params = Array.from(url.searchParams.entries()).sort(
    (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
  );
  const canonicalQuery = params.map(([k, v]) => `${k}=${v}`).join("&");
  const stringForm = `${method.toUpperCase()} ${url.pathname}?${canonicalQuery}`;
  return "sha256:" + (await sha256Hex(stringForm));
}

async function hashResponse(result) {
  return "sha256:" + (await sha256Hex(canonicalJSON(result)));
}

async function verifySignature(signed, publicJwk) {
  if (signed.canonical_form !== "afta-canonical-json-v1") return false;
  const core = {
    v: signed.v,
    id: signed.id,
    endpoint: signed.endpoint,
    method: signed.method,
    token_short: signed.token_short,
    credits_charged: signed.credits_charged,
    credits_remaining: signed.credits_remaining,
    request_hash: signed.request_hash,
    response_hash: signed.response_hash,
    captured_at: signed.captured_at,
    server_time: signed.server_time,
    no_charge_reason: signed.no_charge_reason,
    freshness_sla_seconds: signed.freshness_sla_seconds,
  };
  let key;
  try {
    key = await webcrypto.subtle.importKey(
      "jwk",
      publicJwk,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
  } catch (err) {
    console.error("importKey failed:", err.message);
    return false;
  }
  const sig = base64UrlToBytes(signed.signature);
  const message = enc.encode(canonicalJSON(core));
  try {
    return await webcrypto.subtle.verify(
      { name: "Ed25519" },
      key,
      sig,
      message,
    );
  } catch {
    return false;
  }
}

// ── Main ──

async function main() {
  const [, , url, bearer, jwkUrlArg] = process.argv;
  if (!url || !bearer) {
    console.error("usage: node verify.mjs <url> <bearer> [public-jwk-url]");
    process.exit(2);
  }

  console.log(`→ Calling ${url}`);
  const t0 = Date.now();
  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${bearer}` },
  });
  const elapsedMs = Date.now() - t0;
  const body = await res.json();
  console.log(`← HTTP ${res.status} in ${elapsedMs}ms`);

  if (!body.receipt) {
    console.error("No receipt in response. Either the publisher has no");
    console.error("signing key configured (pending_key_bootstrap) or the");
    console.error("response was an unauth 402. Body:", body);
    process.exit(1);
  }

  const receipt = body.receipt;
  console.log("\nReceipt fields:");
  console.log(`  id              ${receipt.id}`);
  console.log(`  endpoint        ${receipt.endpoint}`);
  console.log(`  credits_charged ${receipt.credits_charged}`);
  console.log(`  no_charge       ${receipt.no_charge_reason ?? "(none)"}`);
  console.log(`  signing_alg     ${receipt.signing_alg}`);
  console.log(`  key_id          ${receipt.key_id}`);
  console.log(`  verify_doc      ${receipt.verify_doc}`);

  // Where to fetch the publisher's public JWK from. CLI override wins.
  // Otherwise fall back to a guess based on verify_doc.
  let jwkUrl = jwkUrlArg;
  if (!jwkUrl) {
    const verifyDoc = receipt.verify_doc;
    if (verifyDoc && verifyDoc.startsWith("http")) {
      const docOrigin = new URL(verifyDoc).origin;
      jwkUrl = `${docOrigin}/.well-known/receipt-key.json`;
      console.warn(
        `\n(no public-jwk-url given; guessing ${jwkUrl}. ` +
          "Pin a real URL in production.)",
      );
    } else {
      console.error("No public JWK URL and no verify_doc to guess from");
      process.exit(1);
    }
  }

  console.log(`\n→ Fetching public JWK from ${jwkUrl}`);
  const jwkRes = await fetch(jwkUrl);
  if (!jwkRes.ok) {
    console.error(`JWK fetch failed: HTTP ${jwkRes.status}`);
    process.exit(1);
  }
  const publicJwk = await jwkRes.json();
  if (publicJwk.kty !== "OKP" || publicJwk.crv !== "Ed25519") {
    console.error("Not an Ed25519 public JWK:", publicJwk);
    process.exit(1);
  }

  // Reconstruct the body the publisher hashed (everything except receipt
  // and billing). The publisher computed response_hash over this exact
  // shape in canonical-JSON form.
  const bodyForHash = { ...body };
  delete bodyForHash.receipt;
  delete bodyForHash.billing;

  const expectedResponseHash = await hashResponse(bodyForHash);
  const expectedRequestHash = await hashRequest("GET", url);

  const sigOk = await verifySignature(receipt, publicJwk);
  const responseHashOk = receipt.response_hash === expectedResponseHash;
  const requestHashOk = receipt.request_hash === expectedRequestHash;

  console.log("\nVerification:");
  console.log(`  Ed25519 signature  ${sigOk ? "PASS" : "FAIL"}`);
  console.log(
    `  response_hash      ${responseHashOk ? "PASS" : "FAIL"}` +
      (responseHashOk ? "" : `  (got ${receipt.response_hash}, computed ${expectedResponseHash})`),
  );
  console.log(
    `  request_hash       ${requestHashOk ? "PASS" : "FAIL"}` +
      (requestHashOk ? "" : `  (got ${receipt.request_hash}, computed ${expectedRequestHash})`),
  );

  const allOk = sigOk && responseHashOk && requestHashOk;
  console.log(`\n${allOk ? "OK" : "FAILED"}: receipt is ${allOk ? "valid" : "INVALID"}.`);
  if (!allOk) process.exit(1);
}

main().catch((err) => {
  console.error("verifier error:", err);
  process.exit(1);
});

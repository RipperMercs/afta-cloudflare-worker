/**
 * Federation rail client. Calls the host's validate + commit endpoints
 * with X-Internal-Auth. Includes a small in-memory circuit breaker so
 * repeated 5xx from the host doesn't make every premium call wait the
 * full timeout.
 */

import type { NoChargeReason } from "afta-protocol";

export interface ValidateResponse {
  ok: boolean;
  reason?: string;
  credits_remaining?: number;
  sufficient?: boolean;
}

export interface CommitResponse {
  ok: boolean;
  reason?: string;
  credits_charged?: number;
  balance_after?: number;
  no_charge_reason?: NoChargeReason;
}

export interface FederationClient {
  validate(token: string, cost: number): Promise<ValidateResponse>;
  commit(
    token: string,
    cost: number,
    endpoint: string,
    noChargeReason: NoChargeReason,
  ): Promise<CommitResponse>;
}

interface ClientOptions {
  validateUrl: string;
  commitUrl: string;
  sharedSecret: string;
  fetchTimeoutMs?: number;
}

const BREAKER_THRESHOLD = 4;
const BREAKER_COOLDOWN_MS = 30 * 1000;

export function createFederationClient(opts: ClientOptions): FederationClient {
  const timeoutMs = opts.fetchTimeoutMs ?? 8000;
  let breakerFailures = 0;
  let breakerOpenedAt = 0;

  function breakerOpen(): boolean {
    if (breakerFailures < BREAKER_THRESHOLD) return false;
    if (Date.now() - breakerOpenedAt > BREAKER_COOLDOWN_MS) {
      breakerFailures = 0;
      return false;
    }
    return true;
  }

  function breakerRecord(success: boolean): void {
    if (success) {
      breakerFailures = 0;
      return;
    }
    breakerFailures++;
    if (breakerFailures === BREAKER_THRESHOLD) breakerOpenedAt = Date.now();
  }

  async function fetchWithTimeout(
    url: string,
    init: RequestInit,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async validate(token, cost) {
      if (!opts.sharedSecret) {
        return { ok: false, reason: "billing_unavailable" };
      }
      if (breakerOpen()) {
        return { ok: false, reason: "billing_temporarily_unavailable" };
      }
      try {
        const res = await fetchWithTimeout(opts.validateUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Internal-Auth": opts.sharedSecret,
          },
          body: JSON.stringify({ token, cost }),
        });
        if (!res.ok) {
          // 4xx are legitimate auth failures; do not feed the breaker.
          // 5xx are host-health signals; feed the breaker.
          if (res.status >= 500) breakerRecord(false);
          return { ok: false, reason: "billing_unavailable" };
        }
        const json = (await res.json()) as ValidateResponse;
        if (!json || typeof json.ok !== "boolean") {
          return { ok: false, reason: "billing_unavailable" };
        }
        if (json.ok) breakerRecord(true);
        return json;
      } catch {
        breakerRecord(false);
        return { ok: false, reason: "billing_unavailable" };
      }
    },

    async commit(token, cost, endpoint, noChargeReason) {
      if (!opts.sharedSecret) {
        return { ok: false, reason: "billing_unavailable" };
      }
      try {
        const res = await fetchWithTimeout(opts.commitUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Internal-Auth": opts.sharedSecret,
          },
          body: JSON.stringify({
            token,
            cost,
            endpoint,
            no_charge_reason: noChargeReason ?? null,
          }),
        });
        if (!res.ok) return { ok: false, reason: "billing_unavailable" };
        const json = (await res.json()) as CommitResponse;
        if (!json || typeof json.ok !== "boolean") {
          return { ok: false, reason: "billing_unavailable" };
        }
        return json;
      } catch {
        return { ok: false, reason: "billing_unavailable" };
      }
    },
  };
}

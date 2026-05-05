# Changelog

All notable changes to `afta-cloudflare-worker` are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/) and the project follows [SemVer](https://semver.org/), with the caveat that on the `0.x` line a minor bump may indicate a behavior-relevant fix that is otherwise API-compatible.

## [0.2.0] — 2026-05-05

### Security

- **Race-safe federation reservations.** Threads `reservation_id` through the validate → commit federation flow so concurrent calls from a single agent atomically reserve credits at validate time and consume the reservation at commit. Closes the federation double-spend race identified in the 2026-05-05 AFTA security audit (Google Gemini external review + internal cross-check).

### Changed

- `ValidateResponse` interface now includes optional `reservation_id: string` (returned by hosts running the post-2026-05-05 atomic-reserve contract).
- `FederationClient.commit` signature accepts an optional `reservationId` argument; the request body includes it when present.
- `createPremiumHandler` (the public API) is unchanged. Library threads `reservation_id` internally; consumers do not modify their integration code.

### Added

- Logging for `reservation_not_found` (handler exceeded 5-minute reservation TTL or commit double-fired) — surfaced as `console.warn`.
- Logging for `reservation_mismatch` (token or cost differs from the validated reservation; indicates a buggy or hostile caller) — surfaced as `console.error`.
- 4 new tests covering the reservation flow.

### Backwards compatibility

Consumers do not change their integration code. Hosts that have not yet shipped the reservation contract continue to work via the legacy commit path. The library transparently uses whichever path the host is on.

### Provenance

Published via the Trusted Publisher OIDC workflow at `.github/workflows/publish-npm.yml`. Cryptographic attestation visible on the npm package page.

## [0.1.1] — 2026-05-03

### Fixed

- Node ESM extensions on local imports (allows the package to load cleanly in Node-style ESM environments).

## [0.1.0] — 2026-05-03

### Added

- Initial release. Drop-in Cloudflare Workers middleware for AFTA: extract bearer token, validate against host's `/api/internal/validate`, run handler, staleness check, commit on host's `/api/internal/commit`, sign Ed25519 receipt, return response with receipt embedded.
- All four AFTA no-charge guarantees enforced: `5xx`, `circuit_breaker`, `schema_validation_failure`, `stale_data`.
- `validationFailure` helper for early HTTP 400 schema-validation paths.
- CORS preflight helper.
- Federation client exposed for diagnostics.

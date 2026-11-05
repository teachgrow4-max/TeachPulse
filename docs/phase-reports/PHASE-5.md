# Phase 5 report — Office verification and QR infrastructure

Date: 2026-11-05

## Implemented

- **The four-layer verification engine** (`POST /api/attendance/verify`). The client sends evidence; the server decides. Every layer is evaluated so a person is told about all the problems at once, every attempt (pass or fail) is written to `attendance_verifications`, and the Phase 3 check-in / check-out functions accept nothing else. Design, limits and reason codes: [VERIFICATION.md](../VERIFICATION.md).
  1. **Location** — server-side Haversine distance; rejects missing, malformed, mocked, stale, future-dated, imprecise and out-of-radius readings; reliability is judged before the radius.
  2. **Office network** — the address Express resolves (`req.ip`) matched against a CIDR allowlist by Postgres, IPv4 and IPv6, most specific range recorded. Forwarding headers are ignored unless an exactly-configured trusted proxy added them.
  3. **Rotating QR** — HMAC-derived per rotation window (nothing to store in clear), accepted 5 s early and 10 s late, compared as exact text, only a SHA-256 stored and only once scanned, **single use per employee** (D1), spent only when the whole verification succeeds.
  4. **Registered device** — native apps sign a single-use server challenge with an on-device ECDSA P-256 key; browsers use a WebAuthn platform passkey (D2). Registration is gated: password re-entry (with the sign-in lockout), proof of the key, admin approval, a per-person cap. Revocation is immediate, including for verifications already issued. A passkey counter that fails to advance is reported as a suspected copy.
- **Office configuration** (admin): settings with a readiness report, network allowlist CRUD with CIDR normalisation and a warning for ranges that can never be a public office address, and `POST /api/admin/office/test` to try an address and a location without writing anything.
- **QR endpoints:** `GET /api/office/qr/current` for the lobby display account, `POST /api/office/qr/verify` for instant feedback after scanning (never consumes the code).
- **Device endpoints:** register (two steps), list, remove; admin queue with approve / revoke; `POST /api/attendance/challenge` for the per-check-in challenge.
- **Shared contracts:** reason catalogue (stable code + message + hint for every failure), request/response schemas, and the exact bytes a device signs, so the apps and the server cannot disagree.

## Files

Created — `apps/api/src/`:
`verification/` (gps, qr, qr-service, network, service), `devices/` (proofs, webauthn, attestation, challenges, repository, service, verify), `office/` (repository, service), `routes/` (office, attendance, devices, admin-office, admin-devices, helpers), `db/errors.ts`, `testing/` (software-device, software-authenticator), and the test files beside each.
`packages/shared/src/` (verification, office, devices). `supabase/migrations/20261105000900_office_verification.sql`. `docs/VERIFICATION.md`.

Modified — `app.ts` (wiring), `config/env.ts` (QR secret, WebAuthn settings, placeholder guard), `auth/service.ts` (password re-check extracted as `confirmPassword`), `routes/admin.ts`, `testing/api-harness.ts`, shared `errors.ts` and `index.ts`, `apps/api/package.json` (`@simplewebauthn/server`), `.env.example`, README and the architecture, database and plan documents.

## Database changes

**0009** — QR scan outcome `VALID`; `attendance_policies.max_devices_per_employee` (default 2, 1–10); a unique index so one WebAuthn credential is live for at most one device; **`device_challenges`** (32 random bytes, single use, purpose/device/platform bound, RLS on, no client access); `private.apply_retention` also purges spent challenges.

## Environment variables added

`QR_SIGNING_SECRET` (**secret**, at least 32 characters; production refuses the `.env.example` placeholder), `WEBAUTHN_RP_ID` (defaults to the host of the first `CORS_ORIGINS` entry), `WEBAUTHN_RP_NAME`.

## Test results

| Suite                                                 | Result                                                                  |
| ----------------------------------------------------- | ----------------------------------------------------------------------- |
| `packages/shared` unit                                | 27 / 27                                                                 |
| `apps/api` unit                                       | 269 / 269                                                                |
| Integration (embedded Postgres 17 + fake auth server) | 780 / 780 (16 files)                                                             |
| Typecheck, ESLint, Prettier, production build         | clean                                                                   |
| Smoke test of the compiled server                     | refuses to boot without `QR_SIGNING_SECRET`; with it, serves health and every new route behind authentication (401), unknown paths 404 |

Covered, beyond the per-module cases: Haversine against known distances, hemispheres and the antimeridian; every GPS rejection with its exact inclusive boundary; QR derivation, windows, grace, early tolerance, forgery (wrong secret, office, rotation, window, one character, every alternative spelling of the final character), replay, per-person single use, hash-only storage; CIDR v4/v6; **forged `X-Forwarded-For`, `X-Real-IP`, `Forwarded`, `CF-Connecting-IP`, `True-Client-IP` with and without a trusted proxy**; device enrolment (wrong password and lockout, every signature mistake, wrong origin / relying party / unverified user / separate security key, duplicates, caps, expired and replayed challenges); every challenge failure mode; **revoked device, before and after a verification was issued**; a copied passkey; **all 16 combinations of the four layers passing and failing**, each checked in the response and in the stored record; the hand-off to `private.check_in` / `check_out`; rate limits; and proof that no coordinate, code, signature, challenge, key or password reaches a log line.

Two safeguards were checked by deliberately breaking the code to prove their tests can fail (findings 1 and 6 below).

## Review findings fixed during the phase

1. **QR single use could be bypassed.** The code was compared after base64url _decoding_. The last character carries only 4 significant bits, so four different spellings of one code decoded identically, hashed differently, and so looked like four different tokens: one scan could be used four times. Comparison is now of the exact text. A unit test sweeps all 64 final characters; reverting the fix makes it fail with `['A','B','C','D']` accepted. (An existing "flip any character" test had been passing by luck, one run in sixteen.)
2. **A challenge returned from the database came back as a `Uint8Array`, not a `Buffer`** under the embedded driver, so `toString('base64url')` produced comma-separated numbers and every native registration failed its signature check. Normalised to a `Buffer` in one place.
3. **The audit writer redacted `passkey_type`** (its name contains "pass"), hiding the very fact an administrator needs to judge a passkey. Renamed to `synced_across_devices` / `backed_up`.
4. **A challenge consumed outside a transaction** would have let two simultaneous requests both spend it. It is now locked and spent in one transaction that commits even when the proof is wrong.
5. **A typo in the password must not cost the person their challenge.** The password is checked first, before the challenge is spent.
6. Spoofing tests were mutation-checked: forcing Express to trust every proxy makes the three `X-Forwarded-For` cases fail. The other headers pass either way because Express never reads them.

## Not verified / limitations

- **No real Supabase stack** (Docker Desktop still cannot start here). Everything ran on embedded Postgres 17 and an in-repo fake of Supabase Auth, as in Phase 4. The password re-check in device enrolment goes through the same untested-against-GoTrue path as `change-password`.
- **Play Integrity and App Attest are not implemented.** The `AttestationVerifier` seam exists; native devices are recorded with attestation `NONE` and should not be described as attested. They need the real app build and vendor accounts (Phase 9).
- **Real hardware is untested.** The passkey tests use a software authenticator that produces genuine WebAuthn bytes and runs them through the real `@simplewebauthn/server`; real browsers, platform authenticators and phone key stores arrive with Phases 7 and 9.
- **Concurrency is reasoned, not raced.** One verification at a time per person is enforced by a transaction-level advisory lock plus a unique index, but the embedded database has one connection.
- **The `channel` in a request is not authenticated**, so the lighter of the web and mobile policies effectively binds everyone (documented; defaults are identical).
- **Synced passkeys** are not tied to one machine; recorded at registration, not blocked.
- **The office network layer needs a stable public address** and cannot see which Wi-Fi network a browser is on. Mobile data fails by design (D8). Someone genuinely on the office network can relay for someone who is not.
- Rate limits are per API instance.
- The `Forwarded` / invalid-address warnings printed by `express-rate-limit` under hostile headers are noise, not failures.
- Phases 6 to 12 not started: there are still no check-in / check-out / break endpoints, so the verification described here is not yet reachable from a screen.

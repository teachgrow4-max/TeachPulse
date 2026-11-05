# Phase 4 report — Authentication and roles

Date: 2026-11-05

## Implemented

- **Sign-in** (`POST /api/auth/login`) through Supabase Auth, with durable account lockout, per-IP failure budgets, CSRF protection for the cookie flow, and an audit trail. Web receives the refresh token only as an `HttpOnly` cookie; mobile receives it in the body.
- **Sessions:** `refresh` (rotation, reuse detection), idempotent `logout` (this device or all), `me`, and `change-password` (re-authenticates, ends other sessions).
- **Request authentication:** JWT verified locally (asymmetric JWKS or legacy HS256, never confused), then the person is loaded from the database on every request and the token's session must still exist, so deactivation, role changes and logout are immediate.
- **Roles:** `requireRole`, with denials audited. Forced first-login password change enforced by the API.
- **Administration:** employees (create, list/search/filter/page, read, edit, activate/deactivate, change role, reset password) and departments (list, create).
- **Safeguards:** admins cannot demote or deactivate themselves; the database refuses to remove the last active administrator; profiles are never hard-deleted; deactivation also bans the user at the auth provider and revokes sessions; Row Level Security now requires an active profile.
- **First administrator:** `npm run bootstrap:admin` (flags, env or hidden prompts; refuses if an administrator exists; race-safe).

## Files

Created — `apps/api/src/`: `auth/` (token-verifier, gateway, service, lockout, cookies, csrf, password, identity, sessions, context), `audit/audit.ts`, `employees/` (service, bootstrap), `middleware/authenticate.ts`, `routes/` (auth, admin), `scripts/` (bootstrap-admin, bootstrap-admin-cli, prompt), `lib/request-meta.ts`, `testing/` (fake-gotrue, api-harness, db-adapter) and the test files beside each module. `packages/shared/src/` (auth, employees). `supabase/migrations/` 0007, 0008. `docs/AUTH.md`.
Modified — `app.ts` (wiring), `config/env.ts` (new settings), `db/pool.ts` (`Queryable`, transactions), `lib/errors.ts`, `lib/logger.ts`, `middleware/rate-limit.ts`, `middleware/error-handler.ts`, shared `errors.ts`, `.env.example`, `supabase/config.toml`, docs and README. The Phase 3 RLS test that deactivated the only administrator was updated: the new guard correctly refused it.

## Database changes

- **0007** `profiles.must_change_password`; partial index on `audit_logs` for the lockout lookup; hard-delete guard on `profiles`; `private.protect_last_admin()` trigger (advisory-locked).
- **0008** `private.is_active_user()`; own-row and announcement policies now require an active profile.

## Environment variables added

`SUPABASE_JWT_SECRET` (legacy, optional, secret), `SUPABASE_JWKS_URL`, `JWT_ISSUER` (optional overrides), `AUTH_COOKIE_SAMESITE`, `AUTH_COOKIE_SECURE`, `AUTH_COOKIE_DAYS`, `LOGIN_MAX_FAILURES`, `LOGIN_LOCKOUT_MINUTES`, `LOGIN_IP_FAILURE_LIMIT`, `USER_RATE_LIMIT_PER_MIN`, and (script only) `BOOTSTRAP_ADMIN_*`. `RATE_LIMIT_GLOBAL_PER_MIN` default raised from 300 to 1000 because a whole office can share one public IP. Production now refuses insecure cookie, HTTP-provider and `SameSite=None`-without-`Secure` settings. Details in `apps/api/.env.example`.

## Test results

| Suite | Result |
| --- | --- |
| `packages/shared` unit | 27 / 27 |
| `apps/api` unit | 172 / 172 |
| Integration (embedded Postgres 17 + fake auth server) | 368 / 368 |
| Typecheck, ESLint, Prettier, production build | clean |
| Smoke test of the compiled server and CLI | headers, readiness, 401/403 paths and CLI help behave as designed |

Covered: sign-in success and every failure mode; lockout (threshold, unlock, no extension, no enumeration, case-insensitivity, reset on success); per-IP budgets that junk cannot burn; CSRF (missing/foreign origin, missing/wrong header); token forgery (edited payload, wrong key, `alg: none`, key confusion, wrong issuer/audience, anon and service-role keys, unknown or foreign session); expiry on an injected clock; JWKS outage and caching; refresh rotation and theft detection; logout when the access token has expired; password change; forced password change; deactivation, reactivation and role change taking effect on the next request; provider outage and provider-sync failures; profile-insert failure cleanup and uniqueness races; bootstrap (success, repeat, concurrency-safe guard, bad input, prompts); and proof that no password, token, cookie or temporary password reaches a log line.

## Review findings fixed during the phase

1. The lockout compared timestamps; a failure stamped in the same instant as a success was ignored. It now orders by audit-row id.
2. `auth-js` retries a failing refresh for up to ~30 s, which would hang requests in an outage. The refresh grant is now a direct single-attempt call.
3. The per-IP limiter counted every 4xx, so a hostile web page could burn a visitor's (or an office's) sign-in budget. It now counts only genuine credential failures.
4. Deactivation was not immediate through Supabase's Data API / Realtime. Own-row RLS now requires an active profile.
5. `--help` on the bootstrap CLI needed a full environment; it no longer does.

## Not verified / limitations

- **No real Supabase Auth server was available** (Docker Desktop still cannot start here). Everything above ran against an in-repo fake of Supabase Auth plus the real `@supabase/auth-js` library and an embedded Postgres. Real GoTrue error bodies, the `auth.sessions` schema on a live stack, and the admin API's ban behaviour are unproven. **Run the auth flows once against the real stack before relying on this.**
- GoTrue's own endpoints stay publicly reachable with the anon key, so password guessing directly against them bypasses this API's lockout (bounded by GoTrue's rate limits and password policy). Details and mitigations in `docs/AUTH.md`.
- Rate limits are per API instance; GoTrue's per-IP limits see the API server's address for every user.
- No self-service forgot-password or email change (needs SMTP) and no MFA.
- Browser behaviour is asserted at the HTTP-header level only; real-browser tests arrive with the web app.
- Phases 5 to 12 not started.

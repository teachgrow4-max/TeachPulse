# Authentication, sessions and roles

Status: implemented and tested in Phase 4. See [Verification status](#verification-status) for exactly what has and has not been proven.

## Model in one page

- **Supabase Auth (GoTrue)** owns users, password hashing and refresh tokens. The API never stores a password.
- **The API is the front door.** Clients call `POST /api/auth/login`; the API checks lockout, calls GoTrue, loads the person from `public.profiles`, and writes the audit trail.
- **Access token:** a short-lived Supabase JWT (set the project's JWT expiry to **15 minutes**; the local stack is configured so). Verified locally by signature, issuer, audience and expiry. Sent as `Authorization: Bearer`.
- **Refresh token:** web keeps it in an **HttpOnly cookie** that page JavaScript can never read; mobile keeps it in Expo SecureStore and sends it in the request body.
- **Who you are is never read from the token.** Role, active flag and forced-password-change come from the database on every request, and the token's session must still exist in `auth.sessions`. So deactivation, role changes and logout take effect on the very next request.
- **No self-signup.** Only an administrator (or the one-time bootstrap script) creates accounts.

## Endpoints

| Method | Path | Who | Notes |
| --- | --- | --- | --- |
| POST | `/api/auth/login` | anyone | `{email, password, client: "web"\|"mobile"}`. Web requires the CSRF headers. |
| POST | `/api/auth/refresh` | cookie (web) or `{refreshToken}` (mobile) | Rotates the refresh token. |
| POST | `/api/auth/logout` | optional bearer, cookie/body token | Always `204`. `{allDevices: true}` signs out everywhere. |
| GET | `/api/auth/me` | bearer | The signed-in person. |
| POST | `/api/auth/change-password` | bearer | `{currentPassword, newPassword}`; `204`. |
| GET, POST | `/api/admin/departments` | admin | List / create. |
| GET, POST | `/api/admin/employees` | admin | List (search, filters, paging) / create. |
| GET, PUT | `/api/admin/employees/:id` | admin | Read / edit, activate, deactivate, change role. |
| POST | `/api/admin/employees/:id/reset-password` | admin | New temporary password, signs the person out everywhere. |

All errors have the shape `{error: {code, message, requestId, details?}}`. The `code` values are stable and listed in `packages/shared/src/errors.ts`. Auth-related ones:

| Code | HTTP | Meaning |
| --- | --- | --- |
| `UNAUTHENTICATED` | 401 | Missing, invalid, expired or revoked credentials. Identical for every cause. |
| `INVALID_CREDENTIALS` | 401 | Wrong email or password (same response for unknown accounts). |
| `ACCOUNT_LOCKED` | 429 | Too many failures; `Retry-After` header and `details.retryAfterSeconds`. |
| `ACCOUNT_DEACTIVATED` | 403 | Account switched off by an administrator. |
| `PASSWORD_CHANGE_REQUIRED` | 403 | Temporary password still in use; only `/me`, `/logout`, `/change-password` work. |
| `CSRF_REJECTED` | 403 | Browser request without an approved `Origin` and the custom header. |
| `FORBIDDEN` | 403 | Signed in, but the role does not allow it (audited as `authz.denied`). |
| `SELF_MODIFICATION_FORBIDDEN` | 403 | An administrator tried to demote or deactivate themselves. |
| `LAST_ADMIN` | 409 | Database guard: the last active administrator cannot be removed. |
| `RATE_LIMITED` | 429 | Per-IP or per-user request budget exceeded. |

## Web client contract (used by Phase 7)

1. Send every API request with `credentials: "include"`. The browser adds `Origin` itself.
2. For `login`, `refresh` and `logout` also send `X-Requested-With: teachgrow-web` (`CSRF_HEADER_NAME` / `CSRF_HEADER_VALUE` in `@teachgrow/shared`).
3. Keep the access token **in memory only** (never `localStorage`).
4. On page load, or on any `401` from a normal call, call `POST /api/auth/refresh` once and retry. If that returns `401`, show the sign-in page.
5. The refresh cookie is `tg_refresh`, `HttpOnly`, `Path=/api/auth`, 7 days (`AUTH_COOKIE_DAYS`).

**Deployment requirement.** `SameSite=Strict` (the default) only works when the web app and the API are on the **same site** (for example `app.teachgrow.in` and `api.teachgrow.in`, or one origin with `/api` proxied). If they must be on different sites (for instance a `vercel.app` frontend and an `onrender.com` API), set `AUTH_COOKIE_SAMESITE=none` (requires HTTPS). `SameSite=None` gives no CSRF protection of its own, so the `Origin` allowlist and custom header become the only defence; they are enforced and tested.

## Mobile client contract (used by Phase 9)

Send `client: "mobile"` at login to receive `refreshToken` in the body. Store it only in Expo SecureStore. Refresh with `POST /api/auth/refresh {refreshToken}` and replace the stored token with the new one every time (they rotate). No `Origin` or cookie is involved.

## CSRF defence

Only requests that rely on the refresh cookie (web login, refresh, logout) are CSRF-sensitive; every other endpoint authenticates with a bearer header that a cross-site page cannot attach. Those three require **both**:

1. `Origin` present and exactly one of `CORS_ORIGINS`; and
2. the `X-Requested-With: teachgrow-web` header.

The check runs before any password is checked or token used. `SameSite` is an additional layer, not the only one.

## Lockout and rate limiting

| Control | Default | Behaviour |
| --- | --- | --- |
| Account lockout | 5 failures / 15 min (`LOGIN_MAX_FAILURES`, `LOGIN_LOCKOUT_MINUTES`) | Counts failures since the last success, derived from the audit log (durable, shared by all instances). Unlocks by itself. Attempts while locked are logged as `auth.login.blocked` and are **not** counted, so a lock cannot be extended. Unknown emails lock identically, so lockout cannot reveal which accounts exist. The password re-checks for change-password and for **enrolling a device** (`POST /api/devices/register`, see [VERIFICATION.md](VERIFICATION.md)) share the same lock, via `AuthService.confirmPassword`. |
| Per-IP failed sign-ins | 30 / 15 min (`LOGIN_IP_FAILURE_LIMIT`) | Counts only genuine credential failures: successes, malformed requests and CSRF rejections never count (so an office behind one public IP is safe, and a hostile web page cannot burn a visitor's budget). |
| Per-IP failed refreshes | 10x the above | Requests with no token never count. |
| Per signed-in user | 240 / min (`USER_RATE_LIMIT_PER_MIN`) | Keyed by user id, not IP. |
| Per IP, all routes | 1000 / min (`RATE_LIMIT_GLOBAL_PER_MIN`) | Generous on purpose; a whole office can share one IP. |

The limiters are in-memory: correct for **one** API instance. Use a shared store (Redis) before running several.

## Sessions and revocation

Every API call checks that the token's `session_id` still exists in `auth.sessions`. Removing the row (logout, deactivation, password reset or change) therefore kills both the refresh token and the still-unexpired access token immediately.

- Logout works even when the access token has expired: the refresh token is used to find and revoke the session.
- Reusing an already-rotated refresh token is treated as theft. Supabase Auth's reuse detection revokes the session (the test double models this; the real server's behaviour is part of the outstanding live check) and the API records `auth.refresh.reuse_detected` and rejects the request.
- Changing a password signs out every other session. An administrator reset signs out all of them.
- Row Level Security also requires an **active** profile for own-row access, so a deactivated person cannot keep reading their rows through Supabase's Data API or Realtime with a not-yet-expired token.

## Roles

| Role | Can |
| --- | --- |
| `employee` | Mark own attendance and view own history. |
| `admin` | Everything under `/api/admin/*`. May also be an attendance-tracked employee. |
| `attendance_operator` | Front-desk account: scans employees' QR codes and records attendance (`/api/qr-attendance/*`, see [ADMIN_QR_ATTENDANCE.md](ADMIN_QR_ATTENDANCE.md)). Cannot see employee lists, other people's codes, reports or settings. Its own attendance may be tracked. |
| `office_display` | Least-privilege kiosk identity for the lobby QR screen. Cannot be tracked for attendance, and its type cannot be changed to or from another role. |

Safeguards: an administrator cannot demote or deactivate themselves; a database trigger refuses to remove the last active administrator; profiles are never hard-deleted.

## Creating accounts

- **First administrator:** `npm run bootstrap:admin -w @teachgrow/api` (or `bootstrap:admin:prod` against the built output). Values come from flags, `BOOTSTRAP_ADMIN_*` variables or prompts; the password is read without echo or from `BOOTSTRAP_ADMIN_PASSWORD`, and is never printed or logged. It refuses to run if any administrator already exists.
- **Everyone else:** an administrator calls `POST /api/admin/employees`. By default a strong temporary password is generated and returned **once**; the person must change it at first sign-in (enforced by the API, not the UI). An administrator-chosen `initialPassword` is never echoed back.
- **Password policy:** at least 10 characters, with lowercase, uppercase and a digit, at most 72 bytes (bcrypt silently ignores the rest). Enforced by the API and, with the same rules, by Supabase (`minimum_password_length`, `password_requirements` in `supabase/config.toml`; set the same in the hosted project's Auth settings).

### Recovering from a lost administrator

The bootstrap script deliberately refuses once any administrator exists, even a deactivated one. Recovery is a manual database action by someone with database access:

```sql
-- reactivate an existing administrator ...
update public.profiles set is_active = true, deactivated_at = null, deactivated_by = null
  where employee_code = 'TG-001';
-- ... then record why, since manual SQL bypasses the API's own audit entry
insert into public.audit_logs (action, entity_type, entity_id, metadata)
  select 'manual.admin_recovery', 'profile', id::text, jsonb_build_object('note', 'describe what happened and who approved it')
  from public.profiles where employee_code = 'TG-001';
```

Also lift the provider ban in the Supabase dashboard (Authentication, Users) if the account was deactivated through the API.

## Token verification modes

`createTokenVerifier` supports both Supabase signing schemes and keeps them strictly apart:

| Project uses | Configure | Accepts |
| --- | --- | --- |
| Asymmetric signing keys (new projects) | nothing; `SUPABASE_URL` is enough (JWKS at `<url>/auth/v1/.well-known/jwks.json`) | ES256 / RS256 / EdDSA |
| Legacy shared secret (older projects, some local stacks) | `SUPABASE_JWT_SECRET` | HS256 |

A token claiming HS256 is never checked against a public key (algorithm-confusion attack), `alg: none` is refused, and the public anon and service-role API keys are refused (no `aud: authenticated`, `sub` or `session_id`). Required: `iss` = `JWT_ISSUER` (default `<SUPABASE_URL>/auth/v1`), `aud` = `authenticated`, `role` = `authenticated`, UUID `sub` and `session_id`, unexpired (5 s clock tolerance). If a token GoTrue has just issued fails verification, the sign-in fails loudly with `503` and a clear log message instead of silently locking everyone out.

## Supabase project checklist

In the hosted dashboard (Authentication) set: sign-ups **disabled**; email confirmations off (accounts are created pre-confirmed); minimum password length 10 with upper/lower/digit; **JWT expiry 900 s**; asymmetric JWT signing keys enabled; custom SMTP if you later want email flows; enable leaked-password protection and attack protection (CAPTCHA) where your plan allows.

## Known limitations

1. **The auth provider's own endpoints stay reachable.** The anon key is public by design, so someone can call GoTrue's password grant directly and bypass this API's lockout and failure auditing. GoTrue's per-IP rate limits and the password policy bound the damage, and a stolen session is still useless without a profile that is active. If this matters, enable Supabase's password-verification hook (plan permitting) or CAPTCHA protection. Not implemented here because it cannot be verified without a live Supabase project.
2. **Lockout can be used to annoy.** Anyone can lock a known email address out for 15 minutes by failing sign-in five times. The per-IP limiter and the short window limit this; a stronger answer is CAPTCHA after repeated failures.
3. **Supabase's rate limits see the API's address.** All password and refresh grants come from the API server's IP, so GoTrue's per-IP limits (for example 30 sign-ins per 5 minutes) apply to everyone together. The local config raises them; for production raise `sign_in_sign_ups` and `token_refresh` to match the headcount, and load-test in Phase 11.
4. **Rate limits are per instance** (see above).
5. **No self-service "forgot password" or email change**; these need SMTP. Until then an administrator resets passwords. Email is immutable in the API.
6. **No MFA.**
7. **Direct Data API/Realtime use after logout:** logout revokes the session for this API immediately, but Supabase's Data API only checks the JWT, so a token copied before logout can still read that person's *own* rows until it expires (at most 15 minutes). Deactivation does not have this gap (see RLS note above).
8. **The API's database role needs `SELECT` and `DELETE` on `auth.sessions`** (the default `postgres` role has it). A least-privilege role must be granted this explicitly.

## Verification status

| Area | How it was verified | Not verified |
| --- | --- | --- |
| Token verification (both modes, forgery cases, JWKS caching/outage) | 33 unit tests with real signed tokens and a real HTTP JWKS server | Against Supabase's real key endpoint |
| Sign-in, refresh, logout, change-password, lockout, CSRF, rate limits, admin API, bootstrap | 199 HTTP tests running the real app, real gateway and real verifier against an in-repo fake of Supabase Auth and an embedded Postgres 17 | Against a real GoTrue (Docker could not start on the development machine) |
| Database guarantees (last-administrator trigger, active-user RLS, profile retention) | 13 database tests, plus the 156 Phase 3 tests re-run against the new migrations | The real Supabase stack (same Docker limitation) |
| Gateway request shapes and odd responses | 24 tests against a scripted HTTP server, using the real `@supabase/auth-js` | Real GoTrue error bodies |
| Log hygiene | 3 tests capture all log output through login, refresh, create, change-password, logout and an unexpected 500 | |
| Browser behaviour (cookies, CORS, `SameSite`) | Headers asserted at the HTTP level | A real browser (Phase 7 / 11 end-to-end tests) |

Before go-live, run the auth flows once against the real local or hosted Supabase stack: sign in, refresh rotation, logout, deactivate/reactivate, admin create, password change.

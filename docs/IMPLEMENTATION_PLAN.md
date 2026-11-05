# TeachGrow Attendance — Implementation Plan

Status: **Draft v1 for approval.** Companion to [ARCHITECTURE.md](ARCHITECTURE.md).
Last updated: 2026-11-05.

## 0. Ground rules (apply to every phase)

- A feature is reported **done only after its tests pass**. Anything unverified is listed as unverified, not "implemented".
- No hardcoded credentials, office coordinates, IP addresses or employee IDs. These come from env vars or the admin UI.
- No fake verification and no mock attendance data in production code paths. Test fixtures live in test directories only.
- Time is injected through a `Clock` interface so late/half-day/QR-expiry/finalization logic is testable without sleeping.
- Each phase ends with a report: what was built, files created/modified, DB changes, env vars, test results, remaining blockers.
- Git: `git init` at the start of Phase 3, small commits per logical unit, no history rewriting. Commits happen only when you ask me to make them.

## 1. Decisions needed from you

Each has a **recommended default**. If you don't answer, I'll proceed with the default at the phase where it matters.

| # | Decision | Recommended default | Blocks |
|---|---|---|---|
| **D1** | **QR "single-use"** vs one QR on one screen for many employees. Globally single-use means one scan per rotation, so a 10:00 AM queue fails. | Token is **single-use per employee** (the same employee cannot reuse it, even from another device). Many employees may scan the same on-screen code within its 30–60 s window. Stored per-token consumption log. A "strict global single-use + instant rotate" mode can be added as a setting. | Phase 5 |
| **D2** | **Web device layer.** Browsers can't attest. | Bind the web "device" to a **WebAuthn platform passkey**. Alternative: policy flag `DEVICE = NOT_REQUIRED (web)`, recorded on every verification. Or: **mobile-app-only** check-in with web for viewing only. | Phase 5 |
| **D3** | **Checkout verification** is unspecified. Without it, someone can check out from home. | Checkout requires **GPS + office network** (not QR/device re-attestation). Configurable per policy. | Phase 6 |
| **D4** | **Leave source.** "On Leave" needs data, but no table is listed. | Add a minimal admin-managed `leave_records` table (no employee leave-request workflow in v1). | Phase 6 |
| **D5** | **Supabase project.** | A **new dedicated project** for attendance. Dev uses a local Supabase stack in Docker. You create the cloud project and put its keys in server env files. Never paste keys into chat. | Phase 3 (local) / Phase 12 (cloud) |
| **D6** | **API hosting.** | A persistent Node host (Render / Railway / Fly.io / VPS), not pure serverless. | Phase 12 |
| **D7** | **Roles.** | `employee`, `admin`, `office_display`. Say so if you need a scoped HR/manager role. | Phase 4 |
| **D8** | **Cellular data.** Phones on mobile data won't match an office IP. | Accept: employees must be on office Wi-Fi to check in. | Phase 5 |

## 2. External prerequisites (not code, and not possible for me to create)

| Needed for | What | When |
|---|---|---|
| Play Integrity | Google Cloud project + Play Console app | Phase 5/9 |
| App Attest | Apple Developer Program membership + App ID with App Attest | Phase 9 |
| Push (mobile) | Firebase project, FCM service account, APNs key uploaded to Firebase | Phase 10 |
| Push (web) | VAPID key pair (I generate; you store as secrets) | Phase 10 |
| iOS verification | Real iPhone or a Mac. Windows can't run iOS builds or simulators. | Phase 9/11 |
| Production | Hosting accounts, domain, HTTPS certificate | Phase 12 |
| Office config | Real office latitude/longitude and public IP/CIDR ranges, **entered by your administrator in the admin UI** | After Phase 8 |

Until real accounts exist, Play Integrity / App Attest are built behind a verifier interface and tested against recorded fixtures and vendor test vectors. They will be reported as **"implemented, not verified against the real service"**, not as working.

## 3. Phases

### Phase 1 — Inspect existing system — **done**
No portal exists. Greenfield confirmed. Toolchain inventoried. See ARCHITECTURE §1.

### Phase 2 — Architecture and plan — **this document set**
Exit: you approve ARCHITECTURE.md + this plan and answer (or accept defaults for) D1–D8.

### Phase 3 — Database, RLS, backend skeleton
- `git init`, npm workspaces, TypeScript configs, lint/format, `packages/shared`.
- Supabase local stack (`npx supabase init/start`).
- Migrations: 14 required tables + supporting tables (ARCH §5.2), enums, FKs, unique constraints, indexes, `btree_gist` exclusion for breaks, append-only triggers, `updated_at` triggers.
- RLS on every table, `is_admin()` helper, employee own-row `SELECT` policies, no client write policies.
- DB functions: `check_in`, `check_out`, `start_break`, `end_break`, `apply_correction`, `finalize_attendance_day`.
- Express skeleton: config/env validation (Zod), logger, error handler, request ID, helmet, CORS, trust-proxy config, rate-limit scaffolding, health check.
- **Tests:** TypeScript/Vitest database suite instead of pgTAP (decision made during the phase). It runs on embedded Postgres 17 (PGlite) with no Docker, and the identical suite runs unchanged against a real Supabase database by setting `TEST_DATABASE_URL`. Covers RLS isolation, append-only enforcement, constraints, the full engine and finalization.
- **Env:** `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL`, `PORT`, `CORS_ORIGINS`, `TRUST_PROXY`, `NODE_ENV`.

### Phase 4 — Authentication and roles — **done** (see [AUTH.md](AUTH.md) and [the report](phase-reports/PHASE-4.md))
- `/api/auth/login | refresh | logout | me | change-password`, JWT verification (JWKS or legacy secret), role middleware, deactivation enforced per request, login rate-limit/lockout, CSRF protection for cookie endpoints.
- Admin-only employee and department management through the Supabase Admin API; bootstrap of the **first admin** via a one-time CLI script reading credentials from flags, env or a hidden prompt (not committed).
- **Tests:** login success/failure, lockout, deactivated user rejected, role enforcement, token tampering and forgery, CSRF, log hygiene.
- **Not yet verified against a real Supabase Auth server** (Docker could not start on the development machine). Run the auth flows against the real stack before go-live.

### Phase 5 — Office verification and QR infrastructure — **done** (see [VERIFICATION.md](VERIFICATION.md) and [the report](phase-reports/PHASE-5.md))
- Office settings + networks CRUD (admin), CIDR matching in SQL, trust-proxy hardening with tests that spoofed `X-Forwarded-For` is ignored.
- Haversine + accuracy/staleness checks; `attendance_verifications` recording.
- QR service: generation, hashed storage, rotation with grace window, per-employee consumption (D1), cleanup job. `GET /api/office/qr/current` for `office_display`.
- Device registration (gated), revocation, attestation verifier interfaces (Play Integrity / App Attest / WebAuthn per D2). **Built:** app-key and WebAuthn proofs and the `AttestationVerifier` seam. **Deferred to Phase 9:** the Play Integrity and App Attest verifiers themselves (they need the real app build and vendor accounts); native devices are recorded with attestation `NONE` until then.
- Central `verifyPresence()` + `POST /attendance/verify`, `POST /office/qr/verify`, `POST /admin/office/test`.
- **Tests (unit):** Haversine known distances, accuracy/stale rejection, QR expiry/replay, CIDR v4/v6. **(integration):** every layer pass/fail combination, spoofed header, revoked device.

### Phase 6 — Attendance and break engines
- Check-in/out via DB functions, idempotency keys, state machine, break rules (no overlap, lunch allowance, checkout-with-active-break exception), classification (late, half-day, early checkout, overtime), day finalization job, correction workflow (request → admin decision → append-only apply).
- **Tests (unit):** status calc incl. exact 10:19:59 / 10:20:00 boundary, net hours, break math, DST-free Asia/Kolkata date rollover near midnight. **(integration):** duplicate check-in → 409, concurrent check-ins (race), checkout during break, idempotent retry, employee data isolation.

### Phase 7 — Employee web dashboard
- Vite app shell, design system (tokens, shadcn components, badges, skeletons, empty/error states), employee layout, dashboard with live counter, verify → check-in → check-out flow with confirmation, breaks, history (daily/weekly/monthly calendar), profile, correction request.
- Location-permission explainer shown *before* the OS prompt. QR scan via browser camera.
- **Tests:** component tests; Playwright for the employee flows.

### Phase 8 — Administrator dashboard
- Admin layout, overview KPIs (server-computed), live attendance table with filters + Realtime, employee management, device management, office settings (with "test configuration"), policy settings, holidays, leave records, corrections workflow, office QR display screen.
- **Tests:** Playwright admin flows; admin vs employee permission tests.

### Phase 9 — Mobile app (Expo)
- Auth (SecureStore), dashboard parity with web, `expo-location` (foreground, on-demand only), `expo-camera` QR scanning, device registration + attestation hooks, push registration.
- Requires a **dev build** (EAS or local Android) for attestation modules, not Expo Go.
- **Tests:** Jest + React Native Testing Library; Maestro flows on the Android emulator. **iOS: build config and code only, unverified on this machine.**

### Phase 10 — Reports, notifications, audit
- Reports (daily/weekly/monthly, percentage, late, absences, hours, breaks, overtime, missing checkout), CSV + Excel, permission-scoped. Notifications with dedupe; Web Push + FCM. Audit log viewer.
- **Tests:** report correctness on seeded fixtures, CSV-injection neutralization, duplicate-notification prevention, export permission checks.

### Phase 11 — Security and end-to-end testing
- `docs/THREAT_MODEL.md` and `docs/SECURITY.md`, dependency audit, header/CSP review, rate-limit abuse tests, authorization matrix tests (every endpoint × every role), RLS re-audit.
- Full E2E suite: successful check-in, outside office, GPS disabled, network mismatch, expired QR, duplicate check-in, successful checkout, missing checkout, admin correction.

### Phase 12 — Production documentation
- `docs/API.md` (OpenAPI), `docs/ENVIRONMENT.md`, `docs/DEPLOYMENT.md`, `docs/ADMIN_SETUP.md`, backup/restore and data-retention runbook, go-live checklist including staging validation of the real office IP/proxy chain.

## 4. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Real-world GPS accuracy indoors | Legitimate employees rejected | Configurable radius/accuracy, clear retry UX, admin test tool, measure on-site before enforcing |
| Office ISP IP changes | Everyone locked out | Multiple networks supported, admin alert on a spike of network failures, fast edit path, documented runbook |
| Attestation needs external accounts | Device layer unverifiable until accounts exist | Verifier interfaces + fixtures; report honestly as unverified |
| iOS untestable on Windows | iOS quality unknown | EAS cloud build + real-device test checklist; no "tested" claim until done |
| Scope size | Slippage | Strict phase gates; each phase independently demonstrable |

## 5. What I need to start Phase 3

1. Your approval of the architecture, or the changes you want.
2. Answers to D1–D8, or "use the defaults".
3. Confirmation that I may run `git init` in the project folder and install dependencies (`npm install`, `npx supabase`, Docker containers for the local Supabase stack).

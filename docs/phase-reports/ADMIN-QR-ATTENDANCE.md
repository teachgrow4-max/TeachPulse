# Feature report — Admin-operated QR attendance

Date: 2026-11-06 · Branch `feature/admin-qr-attendance` (cut from `main` at `313538f`) · Nothing committed or pushed.

Design, flows, API and threat model: [ADMIN_QR_ATTENDANCE.md](../ADMIN_QR_ATTENDANCE.md). This report is what was built, what was found on the way, and what is still open.

## Read this first

- **There was no web app and no admin dashboard.** The request said to reuse "the existing admin dashboard"; the repository contained the API and the shared package only. This feature therefore **creates `apps/web`** (sign-in, profile, scanner, QR management). It is a foundation for Phases 7 and 8, not those phases.
- **Phase 6 was being built in the same folder by another session** (uncommitted) while this was done. To avoid trampling it, this work lives in a separate git worktree (`D:\attend-qr`) on its own branch. It builds on the committed Phase 3 to 5 engine, not on Phase 6's unfinished service layer, and it reuses Phase 6's idempotency helper verbatim (same path, same shared error code) so the two should merge cleanly. See _Merging_.
- The attendance rules were **not duplicated**. `check_in` / `check_out` were split into a shared core that both the employee's own check-in and the operator's QR check-in call.

## Implemented

1. **Unique employee QR identities.** One live code per employee, issued in the same transaction as the account (and lazily, or by "Issue missing codes", for older accounts). A 256-bit keyed derivation (HMAC under `EMPLOYEE_QR_SECRET` over the employee and a random nonce); **only `SHA-256(code)` and the nonce are stored**; nothing about the person is inside the code. Regenerating invalidates every earlier code at once; revoking leaves the person with none until regenerated. Employees see and download their code (PNG / PDF ID card); administrators can view, download, regenerate and revoke any code.
2. **Administrator / operator scanner** (`/scanner`): camera on Android, iOS and desktop webcams, permission states, camera picker, torch, scanning frame and animation, "scan from a photo", employee card (photo or initials, name, ID, department, designation, account status, today's status, check-in and check-out times), recent scans, "Scan another employee".
3. **Automatic action detection, with confirmation.** CHECK IN, CHECK OUT, ALREADY CHECKED OUT, or the reason it cannot be recorded; rejection of inactive employees and revoked or unknown codes. Scanning never records; the operator must confirm; a repeated scan changes nothing. **Nobody can record themselves** with the scanner (see _Findings_).
4. **Authorisation and evidence.** Only `admin` and the new `attendance_operator` role reach the scanner (employees get 403 and an audit entry). Each recording keeps the operator, the employee, the server time, the scanning device, the action, the QR result and the operator's **own office verification** (new purpose `ADMIN_SCAN`, layers from `attendance_policies.admin_scan_layers`, default location + network).
5. **Integration with the attendance engine.** Same `attendance_records` and immutable `attendance_events` (source `ADMIN_QR`), same late rule, server timestamps only, one transaction, `Idempotency-Key` required, corrections through the existing workflow.
6. **Database:** `employee_qr_codes`, `qr_scan_logs`, constraints, indexes, RLS with column-level grants, guard triggers, audit entries.
7. **Admin management** (`/admin/qr`): search, filter, view, download, regenerate, revoke, issue missing codes, scan history filtered by date, employee, who recorded it and outcome.
8. **UI:** large camera area, scanning animation, identification card, big action button with confirmation, success animation, error feedback with reasons, responsive layout (checked at desktop and 375 px), dark and light themes, reduced-motion support.
9. **Security tests** for every scenario in the request (table in the design document).

## Files

Created: `supabase/migrations/20261106000100_admin_scan_purpose.sql`, `…000200_employee_qr_attendance.sql`; `apps/api/src/employee-qr/{token,service}.ts`, `qr-attendance/service.ts`, `attendance/idempotency.ts` (copy of Phase 6's), `routes/{employee-qr,qr-attendance,admin-employee-qr}.ts`, `testing/{qr-fixtures,qr-scene,dev-server}.ts`; their tests; `packages/shared/src/employee-qr.ts`; the whole of `apps/web/`; `docs/ADMIN_QR_ATTENDANCE.md` and this report.

Modified (small and additive): `app.ts`, `routes/admin.ts`, `config/env.ts` (+ tests, `.env.example`), `employees/service.ts` (optional QR issuer), `office/repository.ts` (`adminScanLayers`), `verification/service.ts` (`ADMIN_SCAN`), `testing/api-harness.ts`, `db/schema.integration.test.ts`; shared `enums.ts`, `errors.ts`, `verification.ts`, `devices.ts`, `index.ts`; `eslint.config.js` (browser globals for `apps/web`); `package-lock.json`; README and the architecture, auth, database, verification and plan documents.

## Database changes

`attendance_events.source` accepts `ADMIN_QR`; `verification_purpose` gains `ADMIN_SCAN`; `attendance_policies.admin_scan_layers`; new tables `employee_qr_codes` and `qr_scan_logs`; new role `attendance_operator`; new functions `record_check_in`, `record_check_out`, `assert_scanner`, `qr_attendance_state`, `admin_qr_record`; `check_in` and `check_out` redefined to call the core (same signatures and behaviour).

## Environment variables added

`EMPLOYEE_QR_SECRET` (**secret**, at least 32 characters, must differ from `QR_SIGNING_SECRET`; the `.env.example` placeholder is refused in production). The web app has two optional build-time settings: `VITE_API_BASE` (default same origin) and, for the dev server only, `VITE_API_PROXY` (default `http://127.0.0.1:4000`).

## Test results

| Suite | Result |
| --- | --- |
| `packages/shared` unit | 27 / 27 |
| `apps/api` unit | 293 / 293 (269 before; +21 token, +3 environment) |
| Integration (embedded Postgres 17 + fake auth server) | **972 / 972** (780 before; +60 database, +91 scanner API, +41 management API) |
| `apps/web` (Vitest, jsdom, Testing Library) | 106 / 106 |
| Typecheck (shared, api, web), ESLint, Prettier, production builds (api, web) | clean |

The 43 original engine tests, which exercise the refactored `check_in` and `check_out`, pass unchanged.

**Mutation checks** (safeguards broken on purpose, then restored byte for byte): accepting revoked codes, letting the `employee` role into the scanner, and removing the check that the presence proof belongs to the operator. Ten tests failed, as they should.

**By hand in a real browser** (see the design document): the full scan, confirm and success loop; check-in then check-out then already-checked-out; an inactive employee; an unknown code; a refused office check; the profile and QR; an ID-card PNG; the administrator's pages including regenerate and history; the phone layout. The camera was a canvas stream showing a genuine QR (the pane has no camera and blocks the permission), and the browser location was replaced by a fixed position.

## Findings fixed during the work

0. **An operator or administrator could record their own attendance with the scanner**, which checks fewer things than a check-in may require (the lobby code and a registered device are optional for it), so it was a way round the stricter policy. Found in a final design review, not by a test. Now refused (`SELF_SCAN_FORBIDDEN`, 403) in the application and by a database constraint; the attempt stays in the history as a refusal. An administrator who also marks their own attendance uses the ordinary check-in. Tests added at both levels.

1. **Scan history failed with a server error** when no outcome filter was given: the count query carried a parameter that the statement never mentioned. Found by the API tests; fixed.
2. **A new sign-in was sent to the previous person's page.** After an operator signed out, an employee signing in landed on `/scanner` and was told they had no access. Found in the real browser; the "return to where you were" address is now honoured only if the new person may open it (and only for known pages of the app). Regression tests added.
3. **A wrong claim in a comment:** `EMPLOYEE_QR_SECRET` was documented as invalidating printed cards when rotated. Scanning uses the stored hash only, so rotation stops cards being *displayed*, not scanned. Comments and docs corrected, and a test pins the real behaviour.
4. A failure message repeated each reason twice; the camera picker's default label was too long for a phone. Tidied.
5. Code history used a creation-time ordering that is ambiguous when two codes are made in the same instant (the test clock is fixed); an "active first" tie-break makes it deterministic.

## Decisions to review

| Decision | Alternative |
| --- | --- |
| A code is **derived** from a server secret so profiles and ID-card downloads can show it again; only its hash is stored. | "Shown once, never recoverable": stricter, but nobody could download an ID card later. |
| A **separate** `EMPLOYEE_QR_SECRET`. | Reuse `QR_SIGNING_SECRET` (one less setting, but rotating the lobby code would also change how cards behave). |
| New role **`attendance_operator`**, scanner only (it is not an employee account and cannot scan itself). | A permission flag on ordinary employees. The brief says employee accounts must never reach the scanner, so a distinct role is the plain reading. |
| The operator proves **location + network** (no lobby QR) by default; configurable. | Reuse the check-in layers, which would make an operator wait 30 seconds between employees. |
| A scan can be confirmed for the policy's `verification_ttl_seconds` (120 s). | A separate setting. |
| **Revoke leaves no code**; only an administrator regenerates. | Auto-replace, which could hand a new code to whoever caused the revocation. |
| `apps/web` stack: React 19, Tailwind 4, React Router 6, TanStack Query 5, `qr-scanner`, `qrcode`, jsPDF (loaded on demand). | The original brief names Vite, React, Tailwind and shadcn; the shadcn **components** are hand-written equivalents on Radix, not generated by its CLI. |

## Not verified, and open

- No physical camera, no Android phone, **no iPhone / iOS Safari**; printed cards in poor light untested.
- No real Supabase / GoTrue (Docker will not start here); the PDF has not been looked at on paper; true parallel races were reasoned, not raced (one-connection test database); nothing deployed.
- **The scanner cannot satisfy a policy that requires a registered device** (`DEVICE` in `admin_scan_layers`): it needs a browser passkey or app-key flow that belongs with the employee web and mobile work. The page says so and does not offer the button.
- There is **no profile-photo upload** yet (`profiles.avatar_url` must be an https address set by an administrator), so the operator's visual check often has only initials.
- Rate limits are per API instance.
- Not built, deliberately: a "regenerate everyone" action (for a leaked secret), a real-time scan feed, Phase 10 reports for `ADMIN_QR` attendance, a printable multi-card sheet.

## Merging

Cut from `313538f`. Phase 6 (another session, uncommitted at the time) edits several of the same files: expect small additive conflicts in `app.ts`, `routes/admin.ts`, shared `errors.ts` / `index.ts`, `config/env.ts` and `.env.example`. `attendance/idempotency.ts` is an exact copy of that session's file and `IDEMPOTENCY_KEY_REUSED` is added in the same place, so both should merge without a conflict (if Phase 6 changed the helper since, take theirs). **Real hazard:** `…000200_employee_qr_attendance.sql` redefines `private.check_in` / `check_out` with `create or replace`; if Phase 6 redefines them in a later-sorting migration the shared core would be silently lost. After merging, run the engine tests and `employee-qr-attendance.integration.test.ts`. Migration `…000200` uses a `20261106…` version so it sorts after Phase 6's `20261105…` ones.

`origin/main` had also moved since this branch was cut (`390f8e7`: root `.npmrc` with `include=dev`, a root `start` script, README hosting notes; `c2545f8`: trusting the database's certificate authority). Both are now merged into this branch; the only conflict was `README.md` (both sections kept; the "nothing to publish as static files yet" paragraph rewritten, because `apps/web/dist` is static output). `include=dev` should also keep the web app's build tools (all dev dependencies) installed on a host that sets `NODE_ENV=production`; that was checked for the API's build on a clean clone, not for the web app's build and not on a host.

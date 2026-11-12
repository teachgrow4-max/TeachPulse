# Admin-operated QR attendance

How an administrator or attendance operator records an employee's attendance by scanning the personal QR code on their ID card. Built on top of the office-verification engine ([VERIFICATION.md](VERIFICATION.md)) and the attendance engine ([DATABASE.md](DATABASE.md)); it adds no second attendance system.

> **Two different QR codes exist. Do not confuse them.**
>
> | | Office QR | Employee QR |
> | --- | --- | --- |
> | Shown | on the lobby screen | printed on / shown from an employee's ID |
> | Changes | every 30 seconds | never, until an administrator regenerates it |
> | Read by | an employee, to prove they are in the building (a layer of check-in) | an administrator or operator, to record that employee |
> | Looks like | `TG1.<window>.<code>` | `TGE1.<43 characters>` |
> | Tables | `qr_tokens`, `qr_scan_events` | `employee_qr_codes`, `qr_scan_logs` |

## What it does

1. **Every employee has exactly one live QR code**, created automatically with their account. Nothing about the person is inside it.
2. An **administrator or attendance operator** opens the scanner page, points the camera at the code, and sees who it belongs to and what would happen: **CHECK IN**, **CHECK OUT**, **ALREADY CHECKED OUT**, or a reason it cannot be recorded (holiday, weekly off, leave, on a break, inactive, revoked).
3. **Nothing is recorded by scanning.** The operator must press the big button. Scanning the same code ten times changes nothing.
4. On confirming, the server checks that **the operator** is at the office (their location and the office network, per the policy), and then records the attendance **through the same engine and into the same records as an employee's own check-in**, marked `ADMIN_QR`.
5. Administrators can **view, download, regenerate and revoke** any employee's code, and see **every scan**: who scanned, what happened, which device.
6. Employees see their own code on their profile and can download it as a **PNG or PDF ID card**.

## Who can do what

| | employee | `attendance_operator` | `admin` | `office_display` |
| --- | :-: | :-: | :-: | :-: |
| See and download their **own** QR code (`GET /api/employee-qr/me`) | yes | yes | yes | no |
| Use the scanner (`/api/qr-attendance/*`) | **no** | yes | yes | no |
| View / download others' codes, regenerate, revoke, issue missing codes, read the scan history (`/api/admin/*`) | no | no | yes | no |

`attendance_operator` is a new role (seeded by migration `20261106000200`): a front-desk or reception account that scans and records but cannot see employee lists, other people's codes, reports or settings. It is **not** an employee account: it has no employee check-in endpoints. If its own attendance is tracked (`attendance_required`), another operator or an administrator scans its code.

**Nobody records their own attendance with the scanner** (`SELF_SCAN_FORBIDDEN`, HTTP 403). The scanner checks fewer things than a check-in may require (the lobby code and a registered device are optional for it), so letting somebody scan themselves would be a way round the stricter check-in policy. The attempt is kept in the scan history as a refusal; the database also refuses to hold a pending or recorded scan of one's own code. An administrator who also marks their own attendance uses the ordinary check-in, like any employee.

An employee account can never reach the scanner endpoints: the role check refuses it (HTTP 403) and writes an `authz.denied` audit entry. Holding a copy of somebody's code, or being signed in at all, does not let anyone record attendance.

## How a code works

```
TGE1.<token>      token = base64url( HMAC-SHA256( key, employeeId + "\n" + nonce ) )     43 characters
```

- `nonce`: 32 random bytes from the operating system's CSPRNG, stored beside the hash.
- `key`: derived (HKDF-SHA256) from `EMPLOYEE_QR_SECRET`, a secret only the API process holds.
- The database stores **only `SHA-256(code)` and the nonce**. The code itself is never stored.

**Why derived rather than random-and-forgotten.** The employee and administrators must be able to see the same code again whenever they open the profile or download the ID card, yet the database must hold nothing that works as a code. A keyed derivation does both: reading the table reveals no usable code (the secret is also needed), the API can re-derive a code on demand, and a new nonce means a new, unrelated code. If you prefer the stricter "shown once, never recoverable" model, the trade is that profiles and downloads could only show a code at the moment it is issued.

**Lookups hash the exact text that was scanned.** Never decode it: the last base64url character carries only 4 bits, so four different spellings of one code decode identically. (That exact mistake once let a single office-QR scan be reused four times; it was found and fixed in Phase 5, and a test sweeps all 64 possible last characters here too.) Only one spelling is accepted.

**Life cycle**

| Action | What happens |
| --- | --- |
| Account created | A code is issued in the **same transaction** as the account: there is never an employee without one (the lobby-screen account has no ID card). |
| Account that predates this feature | Gets its code the first time anybody asks (the employee opens their profile, an administrator opens or lists them) or when an administrator presses **Issue missing codes** (`POST /api/admin/employee-qr/backfill`). |
| **Regenerate** | The live code is retired and a new one issued, atomically. **Every earlier code stops working immediately.** |
| **Revoke** | The live code is withdrawn (card lost, code copied). The person has **no** code until an administrator regenerates one; nobody quietly replaces it. A reason is required. |
| Viewing a code | Administrators can see any employee's code. Every view is audited (who, which employee), never what they saw. |

The database enforces "exactly one live code per employee" (a unique index), makes the code's identity columns immutable, and allows exactly one edit ever: `ACTIVE → REVOKED`, once.

### The secret, and rotating it

`EMPLOYEE_QR_SECRET` (at least 32 characters, different from `QR_SIGNING_SECRET`, placeholder rejected in production) is what lets the API **show** a code again. Scanning needs only the stored hash. So:

- **Rotating it does not invalidate printed cards.** They keep scanning. The API simply cannot display them any more (it says the code must be regenerated; it never shows a code that would not match its stored hash).
- **To retire codes, regenerate or revoke them.** After a suspected leak of the secret *together with* a database dump, regenerate everyone's code (an attacker with both can compute valid codes for the old nonces).
- The two secrets are separate on purpose, so rotating the lobby code never touches ID cards.

## The three steps of recording

```
 POST /api/qr-attendance/scan                 read the code     -> who, and what would happen   (changes nothing)
 POST /api/qr-attendance/scans/:id/verify     prove the OPERATOR is at the office
 POST /api/qr-attendance/scans/:id/confirm    record it         (Idempotency-Key required)
```

### 1. Scan

`{ payload, scanner: { kind: "WEB" | "MOBILE", label?, camera? } }`

Every scan is written to `qr_scan_logs`, **including refused ones**. Outcomes:

| Detected | Meaning | Operator sees | Can confirm? |
| --- | --- | --- | :-: |
| `CHECK_IN` | Valid code, nothing recorded yet today | green **CHECK IN** | yes |
| `CHECK_OUT` | Checked in, not out (including a day left open overnight) | amber **CHECK OUT** | yes |
| `ALREADY_CHECKED_OUT` | Today is complete | **ALREADY CHECKED OUT** | no |
| `BLOCKED` | Holiday, weekly off, approved leave, a break is running (and no checkout exception), or the day was closed without a check-out | the reason | no |
| refused | Unknown or malformed code (`EMPLOYEE_QR_INVALID`), revoked (`EMPLOYEE_QR_REVOKED`), inactive employee (`EMPLOYEE_INACTIVE`), attendance not tracked (`ATTENDANCE_NOT_TRACKED`) | an error, naming the employee when the code identified one | no |

What is decided comes from the database function `private.qr_attendance_state`, which uses the same facts as `check_in` / `check_out` (day type, leave, open record, breaks, exceptions), so the screen never promises something the engine would refuse.

A scan that needs confirming expires after `verification_ttl_seconds` (default 120 s). A scan that is never confirmed is not rewritten: history simply shows it as **Expired**.

**What is stored about a scan:** the scanning person, the employee, the code's id, a SHA-256 of what was presented (never the text; for malformed input not even that), the device description the client declared plus its user agent, the client address, the request id, and later the confirmation. A malformed scan stores no copy of what was scanned.

### 2. Verify (the operator, not the employee)

`{ channel, gps?, qr?, device? }` → the same verification engine as a check-in, with purpose **`ADMIN_SCAN`**, evaluated for the **operator's** identity. The result is stored as an ordinary `attendance_verifications` row (purpose `ADMIN_SCAN`, `employee_id` = the operator), linked to the scan. The **latest attempt, passed or failed**, is attached to the scan so history shows why a scan did not become attendance.

Which layers: `attendance_policies.admin_scan_layers`, default **GPS + NETWORK**; GPS and NETWORK can never be removed (a database constraint, as for check-in). Administrators can additionally require the lobby QR and/or a registered device.

Why the lobby QR is off by default: it is single-use per person per 30-second rotation, so an operator processing a queue would have to wait for a new code between employees.

Every rule of [VERIFICATION.md](VERIFICATION.md) applies unchanged: the address is the one Express resolved (`req.ip`, never a forwarding header unless a trusted proxy is configured), the location is judged against the office with a server-side Haversine distance, and a failed attempt reports **every** failed layer at once.

### 3. Confirm

`POST /api/qr-attendance/scans/:id/confirm` with `{ action }` and a required `Idempotency-Key: <8-128 chars>` header.

Inside **one transaction** the server: claims the idempotency key, locks the scan, re-checks everything (scan belongs to this operator, still pending, not expired, the action is the one the scan showed, the code is still the employee's live one, the employee is still active and tracked, the operator's verification is theirs, `ADMIN_SCAN`, passed, unspent, unexpired, and from a device that is still approved), runs the **shared engine core** with source `ADMIN_QR`, spends the verification, marks the scan `RECORDED`, writes the audit entry, and stores the answer under the key. Any failure rolls all of it back, **including the key**, so the same request can simply be tried again.

The response (`ConfirmScanResponse`) contains the employee, the action, the server's timestamp and the day's summary.

## One engine, two ways in

Migration `20261106000200` extracts the second half of `private.check_in` / `private.check_out` into `private.record_check_in` / `private.record_check_out`. `check_in` / `check_out` keep their signatures and behaviour (they prove the employee's own verification, then call the core, then spend it); `admin_qr_record` calls the same core. So:

- **Same records.** There is no separate "QR attendance" table. One `attendance_records` row per employee per day; QR scans add events to it.
- **Same rules.** Late arrival (local time ≥ threshold), holiday / weekly off / leave refusal, one check-in per day, break handling, net hours, half-day, overtime, early checkout: all in one place. A database test confirms that for 09:59:59, 10:19:59, 10:20:00, 10:20:01 and 14:00 a check-in through the scanner and a self check-in classify identically down to the policy snapshot.
- **Source recorded.** `attendance_events.source = 'ADMIN_QR'`, `actor_id` = the operator, `verification_id` = the operator's proof, metadata `{ scan_id, qr_code_id, scanned_by }`. The employee's own device is not involved, so no `device_id` is recorded.
- **Server time.** The timestamp is the server's clock at the moment of confirming. The confirm schema is strict: a body that tries to supply `occurredAt` or `timestamp` is rejected with 400.
- **Immutable events.** `attendance_events` is append-only, as before. Mistakes go through the existing correction workflow (`admin_correct`, employee requests, admin decisions); nothing here edits history.

## Database

Migrations `20261106000100_admin_scan_purpose.sql` (the new enum value must be added alone, because a new enum value cannot be used in the transaction that adds it) and `20261106000200_employee_qr_attendance.sql`.

| Object | Purpose |
| --- | --- |
| `roles` row `attendance_operator` | the scanner role |
| `verification_purpose` += `ADMIN_SCAN` | the operator's presence proof; `device_challenges.purpose` accepts it too |
| `attendance_events.source` += `ADMIN_QR` | where the event came from |
| `attendance_policies.admin_scan_layers` | layers the operator must pass; default `{GPS,NETWORK}`, must contain both |
| **`employee_qr_codes`** | `id, employee_id, token_hash (32 bytes, unique), token_nonce, status ACTIVE/REVOKED, generated_at, generated_by, revoked_at, revoked_by, revoke_reason`; one ACTIVE per employee; guard trigger |
| **`qr_scan_logs`** | `id, scanned_by, employee_id, qr_code_id, token_hash, qr_result, detected_action, reason_code, status PENDING/RECORDED/NO_ACTION/REJECTED, scanned_at, expires_at, scanner, client_ip, request_id, office_verification_id/result, confirmed_at/action, attendance_event_id, attendance_record_id`; constraints tie each status to its fields; guard trigger |
| `private.record_check_in` / `record_check_out` | the engine core, shared |
| `private.assert_scanner(user)` | administrator or attendance operator, active |
| `private.qr_attendance_state(employee, now)` | what a scan means right now (JSON) |
| `private.admin_qr_record(scan, admin, action, now)` | records a confirmed scan |

**Integrity** (all enforced by the database, all tested): one live code per employee; code identity columns immutable, one-way revocation; a scan's evidence columns immutable, only its confirmation can be filled in and only once; a finished scan is frozen; each attendance event is explained by at most one scan; one presence proof can back at most one recorded scan; no `DELETE` or `TRUNCATE` on either table.

**Row Level Security and privileges.** Both tables have RLS on; client roles get `SELECT` on **safe columns only** (the hash, nonce, client address, device description and request id are never readable by a signed-in user, administrators included, except through the administrator API for the address and device). Employees see their own code's status and the scans about them; the person who scanned sees their own scans; administrators see all rows; a deactivated person sees nothing. No client role can write either table. The standard lockdown block still allows clients to execute only the three RLS helpers.

**Audit log** (`audit_logs`, append-only): `employee_qr.issued`, `.viewed`, `.regenerated`, `.revoked`, `.backfilled`, `qr_attendance.recorded`, and `authz.denied` for an employee who tries the scanner. Entries name the codes by id and never contain a code or token.

## API reference

All errors have the usual shape `{ error: { code, message, requestId, details? } }`.

| Method and path | Who | Notes |
| --- | --- | --- |
| `GET /api/employee-qr/me` | employee, operator, admin | `{ status: ACTIVE\|REVOKED\|NONE, payload, generatedAt, revokedAt, holder }`. Issues a first code if the person has never had one. |
| `POST /api/qr-attendance/scan` | operator, admin | see above. 200 with the resolution, or 422 with `details.scanId` |
| `POST /api/qr-attendance/scans/:id/verify` | operator, admin | 200 with a `VerifyResponse`, or 422 `VERIFICATION_FAILED` with the reasons |
| `POST /api/qr-attendance/scans/:id/confirm` | operator, admin | `Idempotency-Key` required; `Idempotent-Replayed: true` on a repeat |
| `POST /api/qr-attendance/challenge` | operator, admin | one-time challenge for the operator's registered device (only if the policy asks for it) |
| `GET /api/qr-attendance/recent?limit=` | operator, admin | the caller's own latest scans |
| `GET /api/admin/employee-qr?search=&qrStatus=&departmentId=&page=&pageSize=` | admin | everyone but the lobby account, with code state and last scan |
| `GET /api/admin/employee-qr/:employeeId` | admin | the code to download, and every code the person has had |
| `POST /api/admin/employee-qr/:employeeId/regenerate` | admin | `{ reason? }` |
| `POST /api/admin/employee-qr/:employeeId/revoke` | admin | `{ reason }` (3 to 500 characters) |
| `POST /api/admin/employee-qr/backfill` | admin | `{ issued }` |
| `GET /api/admin/qr-scans?from=&to=&employeeId=&scannedBy=&status=&page=&pageSize=` | admin | dates are calendar days **at the office**; status also accepts `EXPIRED` |

New error codes: `EMPLOYEE_QR_INVALID` 422, `EMPLOYEE_QR_REVOKED` 422, `EMPLOYEE_INACTIVE` 422, `ATTENDANCE_NOT_TRACKED` 422, `SCAN_EXPIRED` 422, `SCAN_ALREADY_RECORDED` 409, `SCAN_NOT_ACTIONABLE` 409, `SCAN_ACTION_MISMATCH` 409, `SELF_SCAN_FORBIDDEN` 403, `IDEMPOTENCY_KEY_REUSED` 422. Existing engine codes (`ALREADY_CHECKED_IN`, `ALREADY_CHECKED_OUT`, `NOT_CHECKED_IN`, `HOLIDAY`, `WEEKLY_OFF`, `ON_LEAVE`, `ACTIVE_BREAK`, `VERIFICATION_*`) are returned unchanged.

Rate limits (per signed-in person, per API instance): scans 120 / minute, office checks 30 / minute, everything else the general per-user limit.

## The web app

`apps/web`: Vite, React 19, TypeScript, Tailwind CSS 4, React Router, TanStack Query. **It is new** (no web app existed before this feature) and contains only what this feature needs: sign-in, forced password change, the profile with the QR card, the scanner, and QR management. It follows the browser contract in [AUTH.md](AUTH.md): access token in memory only, refresh in an HttpOnly cookie, the CSRF header on login / refresh / logout, one renewal and one retry on a 401.

| Route | For | What |
| --- | --- | --- |
| `/login`, `/change-password` | everyone | sign in; choose your own password when you signed in with a temporary one |
| `/profile` | employee, operator, admin | profile and **My QR code** with **Download PNG** and **Download PDF** |
| `/scanner` | operator, admin | camera scanner, employee card, confirm, recent scans |
| `/admin/qr` | admin | **Employee codes** (search, filter, view, download, regenerate, revoke, issue missing) and **Scan history** (date range, employee, recorded by, outcome) |

**The scanner.** `qr-scanner` decodes in a web worker on the device; no video leaves the phone or computer. It works on Android and iOS browsers and desktop webcams (it needs an https page, or localhost). States covered: asking permission, permission denied, no camera, camera in use, insecure page, other errors, each with what to do next; a camera picker when several exist (the choice is remembered); a torch button where the camera has one; and **Scan from a photo** for people who cannot use the live camera. Printed ID cards and phone screens both work. Before recording, the page asks for the operator's own location and shows plain-language reasons if the office check fails.

**ID card downloads.** Drawn locally (nothing is uploaded). The QR is drawn from the module matrix, so it is sharp at any size, and is always black on white even in dark mode. PNG: credit-card proportions (85.6 × 54 mm at about 300 dpi). PDF: the same card as vector at real size (jsPDF, loaded only when someone presses the button).

**Accessibility and motion.** Labelled controls, `aria-live` status messages, focus management in dialogs (Radix), contrast of at least 4.5:1 in light and dark, and `prefers-reduced-motion` turns the scan line, pop-ins and the success animation into plain end states.

### Trying it without Supabase

```bash
npm run build:shared
npx tsx apps/api/src/testing/dev-server.ts      # demo API on :4000, embedded Postgres, invented people
npm run dev -w @teachgrow/web                    # web app on http://localhost:5173
```

The demo seeds an invented office, an administrator, an operator, three employees (one inactive) and a lobby account, and prints how to sign in. It lives under `src/testing`, which the production build excludes. **Never point it at real data.**

### Serving the web app

`npm run build -w @teachgrow/web` produces static files in `apps/web/dist`. Serve them from the **same site** as the API (or follow the cookie notes in [AUTH.md](AUTH.md)), over **https** (browsers only allow the camera and location on secure pages), and send these headers. They are a recommendation that has **not yet been tried against a real host**:

```
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
  img-src 'self' data: blob: https:; worker-src 'self' blob:; connect-src 'self';
  base-uri 'none'; form-action 'self'; frame-ancestors 'none'
Permissions-Policy: camera=(self), geolocation=(self), microphone=()
Referrer-Policy: same-origin
X-Content-Type-Options: nosniff
```

Note that the build tools (TypeScript, Vite, Tailwind) are development dependencies. The root `.npmrc` (`include=dev`, from `main`) keeps them installed even when a host sets `NODE_ENV=production`, which would otherwise skip them and fail the build; that was checked for the API's build on a clean clone, not for this app's build and not on a host.

## Threat model

| Threat | What stops it | What does not |
| --- | --- | --- |
| An operator or administrator records **themselves** with the scanner | Refused in the application and again by a database constraint; the attempt is logged | — |
| A code is photographed or copied (it is a static printed code) | It proves nothing by itself: an operator must scan and confirm, the operator must prove **they** are at the office, the employee's name, ID and photo are on screen for the operator to compare, every scan records device and address, a copied code can be revoked or regenerated in one click, and an employee account cannot reach the scanner. A copy is rejected as the lobby code (`QR_INVALID`). | Somebody who shows a **copy** to an operator **at the office** looks like the real card; only the operator's visual check stands in the way. Without a photo on the profile (there is no upload feature yet) the card shows initials only. |
| Remote operator account takeover | Recording needs a passing office check for the operator on every action (location, office network, optionally lobby QR and device), per-action single-use proof, audit trail | A stolen session used **from the office network** with spoofed GPS. Keep operator accounts few; deactivate promptly (effective on the next request). |
| An operator on site records people who are not there | The audit trail and history show exactly who recorded what, from which device | Collusion on site is detected afterwards, not prevented. |
| Replaying or double-sending a confirmation | Idempotency key, a scan that can be recorded once, a presence proof that can be spent once | — |
| Two operators scanning the same person | Row locks inside the database; the second gets `ALREADY_CHECKED_IN` / `ALREADY_CHECKED_OUT` and the scan stays retryable | See _What was not verified_ |
| Guessing a code | 256-bit; lookups by hash; unknown scans are logged and rate limited | — |
| Database read access | Only hashes and nonces; a usable code needs the secret too | A leak of **both** the secret and the database lets an attacker compute valid codes. Regenerate all codes in that case. |
| Administrators viewing codes | Allowed (they print the cards) but every view is audited | A malicious administrator can mint attendance anyway through corrections. |
| Cross-site request forgery | Bearer tokens (not cookies) on every state-changing call; CSRF header and Origin check on the cookie endpoints | — |
| Hostile text in names or codes | React escapes text; the QR is drawn from numbers, never from HTML; scanned text is never echoed or stored | — |

## What was verified, and what was not

**Verified by automated tests (all passing):** 60 database tests (constraints, immutability, RLS and column privileges, `qr_attendance_state` for every day type, `admin_qr_record` happy paths, late-rule parity and every refusal); 132 API integration tests across `qr-attendance.integration.test.ts` and `employee-qr.integration.test.ts` (every scenario below); 21 token unit tests; 106 web tests (API client, token refresh, scanner page flows with a stub camera, panels, management pages, routing and roles, ID-card drawing and a real PDF); the existing 780 integration, 269 API unit and 27 shared tests, unchanged, including the original 43 engine tests that exercise the refactored `check_in` / `check_out`.

| Requested scenario | Where |
| --- | --- |
| Valid employee QR | scan → verify → confirm for check-in, check-out, admin and operator |
| Invalid QR | malformed text, a web address, a code with one character changed, every other spelling of the last character, a well-formed code nobody was given, the lobby code |
| Self-recording (not requested, found in review) | an operator and an administrator scanning their own code are refused and logged; somebody else can record an operator; nobody else is affected |
| Duplicate QR | repeated scans record nothing; repeated confirmations are idempotent; a new key for a recorded scan is refused |
| Revoked QR | at scan time and between scan and confirm |
| Expired session | expired access token; expired scan; scan that ran out of time before confirming |
| Unauthorized admin | employee, lobby account, deactivated operator, unauthenticated, operator on admin-only endpoints, one operator on another's scan |
| Inactive employee | at scan time and between scan and confirm |
| Duplicate check-in / check-out | two operators; the second is refused and nothing is recorded twice |
| QR copied to another device | works only for an operator who passes the office check; dead after regeneration; useless to an employee |
| Concurrent scans by multiple admins | see below |
| Network failure during recording | connection lost before the attendance is written and after it is written but before the answer is saved: nothing recorded, scan still pending, proof unspent, no key kept, retry with the same key succeeds exactly once |

**Verified by hand in a real browser** (Chromium in the desktop app's browser pane, against the demo API): sign-in, the whole scan → confirm → success loop, check-in then check-out then already-checked-out, an inactive employee, an unknown code, a refused office check (about 5.5 km away), the employee profile and QR, an ID-card PNG drawn on a real canvas, the administrator's list, dialog, regenerate and history, and the phone layout. The camera feed in that pane was a **canvas stream showing a genuine QR**, because the pane has no camera and blocks camera access; the QR decode ran for real in the `qr-scanner` worker. The browser's location was replaced by a fixed position. A bug found this way (a new sign-in being sent to the previous person's page) was fixed and has a regression test.

**Not verified:**

- **A real camera.** No physical webcam, Android phone or **iPhone/iOS Safari** was used; printed cards under glare, at an angle, or on a creased card are untested.
- **A real Supabase stack** (Docker cannot start on the development machine): everything ran on embedded Postgres 17 and an in-repo stand-in for Supabase Auth, as in earlier phases.
- **True parallel races.** The test database has one connection, so "two operators at the same instant" is tested as two operators one after the other plus the database's own guarantees (row locks on the day's record, unique indexes, the single-use proof). The locking was reasoned, not raced.
- **The PDF's appearance.** It is checked to be a real PDF of the right page size with the right content calls; nobody has looked at a printed one.
- **The lobby-code step of the scanner page** exists and is tested with a stub camera, but was not exercised in a real browser; the registered-**device** requirement is **not supported in the web scanner** (the page says so and does not offer the button), so a policy that adds `DEVICE` to `admin_scan_layers` is satisfiable only by a future mobile app.
- **Nothing was deployed or run behind a reverse proxy.**
- Rate limits are per API instance.

## Operations

- **Setup:** set `EMPLOYEE_QR_SECRET` (and keep `QR_SIGNING_SECRET` different), apply the two migrations, then press **Issue missing codes** once for accounts created earlier.
- **Operators:** create an account with role `attendance_operator` (`POST /api/admin/employees`), then give them the scanner page. They need to be on the office network and allow location in their browser.
- **A lost or copied card:** QR management → the employee → **Revoke** (or **Regenerate** to replace it), then print a new card.
- **Changing what an operator must prove:** edit `attendance_policies.admin_scan_layers` (GPS and NETWORK are always kept).

## Notes for merging with Phase 6

This work was cut from commit `313538f` and the Phase 6 session was editing the same folder at the time. Expect small, additive conflicts in `app.ts`, `routes/admin.ts`, `packages/shared/src/errors.ts` and `index.ts`, `config/env.ts` and `apps/api/.env.example`. `apps/api/src/attendance/idempotency.ts` is a verbatim copy of the Phase 6 helper at the same path, and `IDEMPOTENCY_KEY_REUSED` is added in the same place as in that session, so those should merge cleanly. **One real hazard:** migration `20261106000200` redefines `private.check_in` and `private.check_out` with `create or replace`; if Phase 6 also redefines them in a migration that sorts later, that later definition would silently drop the shared core. After merging, run the existing engine tests and this feature's database tests.

`origin/main` had also moved since this branch was cut: `390f8e7` (root `.npmrc` with `include=dev`, a root `start` script, README hosting notes) and `c2545f8` (trusting the database's certificate authority: `config/env.ts`, `config/env.test.ts`, `db/pool.ts`, `.env.example`, README). Both are now merged into this branch. The only conflict was `README.md`, where the demo section and the hosting section were both kept, and the hosting section's "nothing to publish as static files yet" paragraph was rewritten because `apps/web/dist` is static output. `include=dev` should also keep this app's build tools (Vite, TypeScript, Tailwind, all dev dependencies) installed on a host that sets `NODE_ENV=production`; that was checked for the API's build on a clean clone, not for this app's build and not on a host.

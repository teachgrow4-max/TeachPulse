# QR attendance: the employee generates a code, an administrator scans it

How attendance is recorded with QR codes. Built on the office-verification engine ([VERIFICATION.md](VERIFICATION.md)) and the attendance engine ([DATABASE.md](DATABASE.md)); it adds no second attendance system.

> **This replaces the first version of this feature**, in which every employee had a permanent ID-card QR and the *scanning* administrator had to prove they were at the office. See [What changed](#what-changed-from-the-id-card-version).

```
EMPLOYEE   sign in -> location + office network checked -> Generate Attendance QR -> shows it
ADMIN      sign in -> Dashboard -> QR Attendance -> scan -> attendance recorded, employee shown
```

**The two halves are completely separate.**

| | Employee | Administrator / attendance operator |
| --- | --- | --- |
| Location (GPS) | checked, on the server, before a code can be made | **never** |
| Office network (Wi-Fi) | checked, on the server, before a code can be made | **never** |
| Where they can sign in and work from | anywhere (the code just cannot be made away from the office) | **anywhere** |

An administrator is never blocked with "You do not appear to be at the office": the scanner endpoint does not look at the scanner's location or address at all, and the web page does not ask the browser for it.

## What the employee does

Page **Attendance QR** (`/attendance-qr`, the employee's home page).

1. **Check my location and Wi-Fi.** The browser sends its position; the server measures the distance to the office (Haversine, server side) and looks at the address the request really came from. Two rows show the result separately (*Location*, *Office Wi-Fi*). If something fails, the page says exactly what and what to do about it (for example "You are 380 m from the office").
2. **Generate Attendance QR.** Only enabled after step 1 passes, and only if the account is active and has not used up today's codes. The server makes a code for **today** and **one action**: check-in if the person has not checked in, check-out if they have. A large QR appears with a countdown and an *Expires in 1:23* badge.
3. **Show it to an administrator.** The page polls (every 3 s) and turns into *Checked in / Checked out, recorded at 10:03* as soon as the code is scanned. When time runs out it says **Expired**; the person checks again to make a new one.

Regenerating is allowed but bounded: every code needs a **fresh** office check (the proof is spent by generating), a new code **immediately retires** the previous one, and at most `daily_qr_max_per_day` (default **5**) may be made per day.

### "Office Wi-Fi" means the office's network address

A web page cannot read the name of the Wi-Fi network it is on. The check therefore works the way it always has in this system: the server looks at the **public IP address** the request came from and compares it with the list of office networks (`office_networks`, set in the office settings). Add the office's public address range there. This also means a phone on mobile data fails the Wi-Fi check, which is intended.

The distance limit is the office's own `geofence_radius_m`. **The default is now 150 m** (new offices; an office that already exists keeps its value, so check yours — see Operations).

## What the administrator does

Page **QR Attendance** (`/scanner`), in the menu.

1. Open the page; the camera opens (everything is decoded on the device; no video is sent anywhere).
2. Point it at the employee's screen.
3. The server validates the code and records the attendance **in one step** ("Verifying code…" shows while it does). The page then shows an animated tick, **Checked in** or **Checked out**, "Attendance recorded successfully", the **exact time**, and the employee's verification panel: **photo or initials, name, employee ID, department, designation, QR status** (*Valid, now used*), **status** (*Present* / *Late*), the attendance date and the check-in and check-out times. There is no confirm button.
4. *Scan another employee*. A **Recent scans** timeline (photo or initials, name, employee ID, how long ago, result) sits beside the camera.

Refusals are explained in words, and the employee's name is shown when the code identified one:

| Situation | What the scanner says |
| --- | --- |
| The code is used already | **Already scanned**; when it was first recorded; "nothing was recorded twice" (a *duplicate scan* warning on the dashboard) |
| The code ran out of time | **This QR code has expired** |
| The employee made a newer code | **A newer QR code exists** |
| Not a code from this system (a poster, the lobby screen's code, an old ID card) | **QR code not recognised** |
| The employee was deactivated after generating | **Employee account is inactive** |
| The day has moved on (they were checked in some other way meanwhile) | **This QR code is out of date** |
| Holiday, weekly off, leave, on a break, already checked out | the reason, and nothing is recorded |
| The server cannot be reached | **Cannot reach the server**; nothing was recorded; **Try again** sends the same code again without scanning it again |

Nobody can record **their own** attendance (`SELF_SCAN_FORBIDDEN`): an administrator who also marks their own attendance has another administrator scan their code.

## The attendance dashboard (administrators)

Page **Dashboard** (`/admin/attendance`), the administrator's home page.

- **Daily report** for today (refreshed every 30 s) or any past day: *Present*, *Late arrivals*, *Absent*, *On leave*; a table with every tracked employee, their status, **check-in and check-out times**; filters (everyone / present / late / absent, each with its count); **Download CSV**.
- **Warnings** for the day: how many **duplicate scans** and how many **invalid or expired codes**, with a link to the scan history.

*Absent* means "tracked, active, nothing recorded for that day, and the day is not a holiday, a weekly off or approved leave". Early in the day that simply means "not in yet".

## Scan history (administrators)

Page **Scan History** (`/admin/scan-history`): every scan, recorded or refused, with the employee (photo or initials, name, employee ID), the outcome, **who held the camera**, the device, and the address (administrators only). Filters: employee (search by name, ID or email), dates, who scanned, and outcome; 25 per page. A link such as `/admin/scan-history?employee=<id>&name=<name>` opens it for one person.

## QR management (administrators)

Page **QR Management** (`/admin/qr`): where each tracked employee's attendance QR stands on a day (today by default, refreshed every 15 s).

- Five cards: **Total employees**, **Active QR codes** (live right now), **Scanned**, **Missing QR codes** (none made that day) and **Expired codes** (made but never scanned).
- A search (name, employee ID or email), filters by department and QR status, and a day picker.
- A table with the employee, employee ID, department, **QR status** (and what the latest code was for and when it matters), **last scanned**, and a row menu: **View QR activity** (the day's code and the employee's latest scans) and **Open scan history**. On a phone or a tablet each employee is a card.

There is nothing to view, download, print, regenerate or revoke here, on purpose: a code is made by the employee on their own device after the office check, only they see it (once), and the server keeps only its hash. (The ID-card version of this page did those things for permanent card codes, which no longer record attendance.) A "revoke the live code" action could be added later; it is not built.

## How a code works

```
TGD1.<43 base64url characters>        32 bytes from the operating system's CSPRNG
```

- **Random, not derived.** Nothing about the person, the day or the action is inside it, and it cannot be recomputed from anything the server keeps.
- **Hash only.** The database stores `SHA-256(code)` and nothing else; the code itself is shown **once**, in the response to *generate*, and never again (reloading the page means making a new one). Reading the table, a backup or the audit log yields nothing usable.
- **Bound on the server, not in the code.** Each row ties the hash to **one employee, one calendar day (office time) and one action**, plus the employee's passed office verification as evidence. The scanner sends only the scanned text; employee, day and action are looked up, never trusted from the client.
- **Short lived.** `daily_qr_ttl_seconds` (default **90 s**, 30 s to 15 min). A code also dies at midnight, whatever its remaining time.
- **Single use.** One scan records attendance and spends the code; the database enforces one recorded scan per code and one *used* code per employee per day per action.
- **Replaced, not stacked.** At most one live code per employee (a unique index); making another retires the old one.
- **Lookups hash the exact text.** Never decoded (the last base64url character carries only 4 bits, so four spellings decode identically). A test tries all 63 other spellings of a real code's last character; all are refused.

## Rules enforced by the database

Migration `20261107000100_daily_qr_attendance.sql` (no enum is added, so it can be run in one go).

| Object | Purpose |
| --- | --- |
| `attendance_policies.daily_qr_layers` | what must be proved before generating; default `{GPS,NETWORK}`; GPS and NETWORK can never be removed (constraint). Separate from the check-in layers so the lobby code and registered device are not demanded here |
| `attendance_policies.daily_qr_ttl_seconds` / `daily_qr_max_per_day` | lifetime and daily limit |
| `office_locations.geofence_radius_m` default | 150 |
| **`attendance_qr_tokens`** | `id, employee_id, work_date, action, token_hash (unique, 32 bytes), verification_id (unique), verification_waived, status ACTIVE/USED/SUPERSEDED, issued_at, expires_at, used_at, used_by` |
| `qr_scan_logs.daily_qr_id` and widened `qr_result` | scans of these codes (`EXPIRED`, `USED`, `SUPERSEDED` joined the old values); a scan is now written already `RECORDED` or refused |
| `private.issue_daily_qr` | generating: who may, what the code is for (the engine's own next action), the employee's proof is spent, the daily limit, the old code retired |
| `private.daily_qr_record` | scanning: row-locks the code, re-checks every rule against the stored row, runs the **same engine core** as a self check-in with source `ADMIN_QR`, marks the code used, writes the scan log; all in one transaction |

Guarantees (all tested): one live code per person; a code's identity columns never change and it moves only `ACTIVE -> USED` or `ACTIVE -> SUPERSEDED`, once; a finished scan is frozen; no `DELETE`/`TRUNCATE` on either table; one attendance event is explained by at most one scan; **at most one attendance record per employee per day** (the engine's own unique key) and at most one recorded check-in and check-out; the person who scanned can never be the person scanned.

**Row Level Security.** Both tables have RLS on; signed-in users get `SELECT` on safe columns only (never the hash, the address or the device description). Employees see their own codes; administrators see all; a deactivated person sees nothing. The API's own database role does the writing.

**Audit log** (`audit_logs`, append-only): `daily_qr.generated` (code id, action, day, whether the proof was waived; never the code), `qr_attendance.recorded` (scan id, event id, employee, scanner), and `authz.denied` when an employee tries the scanner.

## API

Errors have the usual shape `{ error: { code, message, requestId, details? } }`.

| Method and path | Who | Notes |
| --- | --- | --- |
| `GET /api/attendance-qr/today` | employee, admin (tracked) | what a code would be for (`CHECK_IN` / `CHECK_OUT` / `ALREADY_CHECKED_OUT` / `BLOCKED` + reason), whether one is live, codes made today, the policy's lifetime and limit. Never returns a code |
| `POST /api/attendance-qr/verify` | employee | `{ gps }` -> 200 with a single-use verification and `action`, or 422 `VERIFICATION_FAILED` with `details.layers` and `details.reasons` naming every failed layer |
| `POST /api/attendance-qr/generate` | employee, admin | `{ verificationId }` (omitted for administrators) -> 201 with the code, **once** |
| `GET /api/attendance-qr/:id` | the code's owner | `ACTIVE`/`USED`/`EXPIRED`/`SUPERSEDED` and `usedAt` (the page polls this) |
| `POST /api/qr-attendance/scan` | admin, attendance operator | `{ payload, scanner: { kind, label?, camera? } }` -> 200 with the employee and the day's record, or an error with `details.employee` / `details.firstRecordedAt`. **No location, no address check, no extra fields (a body that sends `gps` is 400).** |
| `GET /api/qr-attendance/recent?limit=` | admin, operator | the caller's own latest scans |
| `GET /api/admin/attendance/daily?date=` | admin | the day's report (summary, warnings, one row per tracked employee) |
| `GET /api/admin/qr-scans?...` | admin | scan history (each person carries `avatarUrl` when they have a photo) |
| `GET /api/admin/qr/overview?date=&search=&departmentId=&state=&page=&pageSize=` | admin | where each tracked employee's code stands on a day: a summary of everyone (`total`, `active`, `used`, `expired`, `none`) and a filtered, paged list of rows. Read-only; never returns a code or its hash |

New error codes: `QR_EXPIRED` 422, `QR_ALREADY_USED` 409, `QR_SUPERSEDED` 422, `QR_LIMIT_REACHED` 429. Existing codes (`EMPLOYEE_QR_INVALID`, `EMPLOYEE_INACTIVE`, `SELF_SCAN_FORBIDDEN`, `SCAN_ACTION_MISMATCH`, `HOLIDAY`, `WEEKLY_OFF`, `ON_LEAVE`, `ACTIVE_BREAK`, `ALREADY_CHECKED_OUT`, `VERIFICATION_*`) are returned as before.

Removed: `POST /api/qr-attendance/scans/:id/verify`, `.../confirm` and `POST /api/qr-attendance/challenge` (the scanner no longer proves anything about itself, and there is nothing to confirm).

Rate limits (per person, per API instance): scans 120/min, verifications 30/min, generations 10/min.

### Administrators and "never asked for a location"

An administrator who also marks their own attendance (`attendance_required = true`) generates a code **without any office verification** (`verification_waived`). The scanning side never asks anyone for a location. This is the rule as requested; it does mean such an administrator can generate a code from anywhere, and the safeguard is that **another** administrator must scan it, so it is visible in the history.

## One engine, two ways in

`private.record_check_in` / `record_check_out` (migration `20261106000200`) are the shared core of the self check-in and of a scan. So there is no separate "QR attendance" table: one `attendance_records` row per employee per day; late rules, holidays, weekly off, leave, breaks, net hours, half days and overtime live in one place. A scan's event has `source = 'ADMIN_QR'`, `actor_id` = the administrator, `verification_id` = the **employee's** office check made when the code was generated. The timestamp is the server's clock at the moment of scanning, never the client's.

## What changed from the ID-card version

| Before | Now |
| --- | --- |
| Permanent ID-card QR (`TGE1...`), issued with the account | Short-lived QR (`TGD1...`) the employee generates each time |
| The **scanner** proved they were at the office (GPS + network) | The **employee** proves it; the scanner is never checked |
| Scan, then verify, then confirm (3 calls) | One call |
| Admin pages to view, download, regenerate and revoke ID cards; PNG/PDF ID card on the profile | Removed from the web app |

Why the ID card could not stay: with nobody proving presence at scan time, a permanent code would let a photograph of a card record attendance from anywhere. The scanner now answers an old card with *"ID-card codes no longer record attendance"*.

**Left in place, unused:** the `employee_qr_codes` table and its `/api/employee-qr` and `/api/admin/employee-qr` endpoints (history is not thrown away; a new account still gets a card code, and the admin employee picker still uses the list endpoint), the `private.admin_qr_record` function, the `ADMIN_SCAN` purpose and `admin_scan_layers`. They can be removed in a follow-up; nothing reachable depends on them for attendance.

## Operations

1. Run migration `20261107000100_daily_qr_attendance.sql` (SQL editor or `supabase db push`).
2. **Set the office's radius to 150 m** if you want it (`update public.office_locations set geofence_radius_m = 150 where is_active;`) and set `max_gps_accuracy_m` high enough for laptops (laptops without GPS often report 100 m or worse accuracy; the default 50 m rejects them).
3. Add the office's public IP range in the office networks (the Wi-Fi check).
4. Tune per policy row: `daily_qr_ttl_seconds`, `daily_qr_max_per_day`, `daily_qr_layers`. Leave `daily_qr_layers` at GPS + NETWORK unless you have a reason: the employee page can supply a location and the server sees the network address, but it cannot supply the lobby code or a registered-device proof, so adding `QR` or `DEVICE` there makes generating a code impossible from the web app.
   ```sql
   -- a code lasts 2 minutes, and a person may make 8 a day
   update public.attendance_policies
   set daily_qr_ttl_seconds = 120, daily_qr_max_per_day = 8
   where id = (select id from public.attendance_policies order by effective_from desc limit 1);
   ```
   There is no settings page for these yet (nor for the other policy columns); they are changed in the database.
5. `EMPLOYEE_QR_SECRET` is no longer needed for attendance codes (they are random); it is still required by the server while the retired ID-card endpoints exist.

## The web app

`apps/web`: Vite, React 19, TypeScript, Tailwind CSS 4, React Router, TanStack Query. It follows the browser contract in [AUTH.md](AUTH.md): access token in memory only, refresh in an HttpOnly cookie, the CSRF header on login / refresh / logout, one renewal and one retry on a 401.

| Route | For | What |
| --- | --- | --- |
| `/login`, `/change-password` | everyone | sign in; choose your own password when you signed in with a temporary one |
| `/attendance-qr` | employee (home page), administrator who marks attendance | location and Wi-Fi check, Generate Attendance QR, the code with its countdown, confirmation |
| `/profile` | everyone | the person's details, and a link to change the password |
| `/admin/attendance` | admin (home page) | Dashboard: daily report, warnings |
| `/scanner` | admin, operator (the operator's home page) | QR Attendance: camera scanner, instant result, recent scans |
| `/admin/qr` | admin | QR Management: where each employee's code stands |
| `/admin/scan-history` | admin | every scan, with filters and pages |
| `/admin/employees/new` | admin | add an employee (a one-time password is generated and shown once) |

The scanner decodes in a web worker on the device (`qr-scanner`); it works on Android and iOS browsers and desktop webcams (an https page, or localhost, is required). It covers permission asked / denied, no camera, camera in use, insecure page, a **switch camera** button where there is more than one, a light button where the camera has a torch, and **Scan from a photo** for people who cannot use the live camera. Accessibility: labelled controls, `aria-live` status messages, contrast of at least 4.5:1 in light and dark, and `prefers-reduced-motion` turns the animations into plain end states.

### Look and feel

One set of design tokens in `src/index.css` (colour, shadow, radius, motion; light and dark): deep teal and emerald as the brand, a quiet neutral canvas, white cards with a hairline border and a very soft shadow. The typeface is Inter, **self-hosted** through `@fontsource-variable/inter`, so nothing is fetched from another site and the content security policy below still holds. Icons are Lucide (`lucide-react`). Shared pieces live in `src/components/ui`: button, badge, card, avatar, stat card, table, segmented filter, dialog, dropdown menu (Radix), toast, empty state, skeleton, page header.

The layout follows the screen: from 1024 px a **sidebar** (grouped menu, the signed-in person, sign out); below that a slim top bar with an account menu and a **tab bar** under the thumb, with **More** for the rest. Dialogs are sheets that slide up from the bottom on a phone. The scanner is a tall portrait frame on a phone and a 4:3 frame on a laptop. Tables become cards below 1100 px. Pages ease in, cards lift on hover, the scanner sweeps, the success tick draws itself; all of it is plain CSS and switches off for people who ask their device for less motion. Nothing on a screen is invented: every number, name and time comes from the API.

### Trying it without Supabase

```bash
npm run build:shared
npx tsx apps/api/src/testing/dev-server.ts      # demo API on :4000, embedded Postgres, invented people
npm run dev -w @teachgrow/web                    # web app on http://localhost:5173
```

The demo seeds an invented office (at 10.0, 20.0, so a browser needs its location overridden to pass the check), an administrator, an operator, employees (one inactive) and a lobby account, and prints how to sign in. It lives under `src/testing`, which the production build excludes. **Never point it at real data.**

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

The build tools (TypeScript, Vite, Tailwind) are development dependencies. The root `.npmrc` (`include=dev`) keeps them installed even when a host sets `NODE_ENV=production`.

## Threat model

| Threat | What stops it | What does not |
| --- | --- | --- |
| Marking attendance from home | The code is made only after a server-side location + network check, and lives ~90 s | Someone at the office who sends the code to a person elsewhere within that window (a screenshot). They must also be at the office to generate it, and the administrator scanning sees the person in front of them |
| Photographing / re-sharing a code | Single use, ~90 s, replaced by a newer one, dead at midnight, bound to the employee | A screenshot sent to a colleague at the scanner within the window is the same as the person being there. The administrator compares the name on screen with who is in front of them |
| Replaying a scan | The code is spent in the same transaction that records attendance; a repeat is refused and logged as a duplicate | — |
| Two scanners at once | Row lock on the code inside the database; one wins, the other gets `QR_ALREADY_USED` | — |
| Guessing a code | 256 bits; lookup by hash; unknown scans are logged and rate-limited | — |
| Database read access | Only hashes; no secret exists that turns them into codes | — |
| Forged location | The server compares the claimed fix with the office, its own clock and the real request address | Spoofed GPS from a device **on the office network** (the network check is the second factor) |
| Admin account takeover | An administrator can record anyone, from anywhere; that is the requested design. Every scan is audited with the scanner, device and address; keep administrator accounts few | A stolen administrator session can mark people present until detected |
| An employee scanning (or being scanned as) someone else | Employee accounts cannot reach the scanner (403, audited); nobody scans themselves | — |
| Cross-site request forgery | Bearer tokens on every state-changing call | — |

## What was verified, and what was not

**Automated (all passing, run on 2026-11-12):** 914 integration tests (19 files, embedded Postgres 17 and an in-repo stand-in for Supabase Auth; 40 of them in `daily-qr.integration.test.ts`), 306 API unit tests, 27 shared tests and 122 web tests (Vitest, jsdom, Testing Library). Typecheck (shared, API, web), ESLint, Prettier and the production builds of the API and the web app are clean. The existing engine, verification, device, auth and office tests run unchanged, apart from the places that named the old 100 m default or scanned an ID card.

**Mutation checks** (a safeguard broken on purpose, the new tests run, the file restored byte for byte): accepting expired codes (3 tests failed), not spending the employee's verification (1), allowing a person to scan themselves (1), and letting employees into the scanner router (1, after the test was sharpened: the first version of that test still passed because the database function also refuses non-scanners, so it could not tell the two layers apart).

**By hand in a real browser** (Chromium in the desktop app's browser pane, against the demo API with invented people; the pane has no camera, so the scanner was fed a canvas stream showing the real QR from the employee's screen, and the real decoder read it):

- An employee 334 m from the office was refused, with *Location: Failed*, *Office Wi-Fi: OK* and "You are about 334 m from the office; you must be within 150 m"; at 56 m the check passed, *Generate Attendance QR* came alive, and a large QR appeared with *Expires in 1:29* and *Waiting for an administrator to scan…*.
- A **different account**, an administrator, opened the dashboard, pressed **Scan Employee QR**, and the scanner read the code and recorded the check-in: name, employee ID, department, date, check-in time and status. The browser's location call was replaced by a counter and it was called **0 times** during all of this.
- The employee's screen turned into *Checked in, recorded at 04:23 PM* without a reload, and offered a check-out code next.
- Scanning the same code again said **Already scanned**, who it was, and when it was first recorded; scanning an expired code said **This QR code has expired**; both appeared in the history and in the dashboard's warnings.
- The dashboard (present, late, absent, check-in times, warnings, history) and the phone layout of the employee page (375 px wide, no horizontal scroll).

**The interface redesign** (new look, new menu, QR Management and Scan History pages) was checked in the same browser, against the demo API, signed in as the demo administrator and employee (not as a real person):

- At **1280 px, 768 px and 375 px wide**, in light mode, and the employee page also in dark mode: login, dashboard, QR Attendance, QR Management, Scan History, Add Employee, My Profile and the employee's Attendance QR. The sidebar becomes a top bar and a tab bar with a **More** sheet below 1024 px; tables become cards below 1100 px; the phone scanner is a tall portrait frame; nothing scrolls sideways.
- The whole flow again with the new screens: the employee (30 m from the invented office) passed the check and made a code; the administrator's scanner read it and showed the confirmation (animated tick, exact time, the employee's panel, a toast and the new entry in *Recent scans*); the same code again gave **Already scanned**; a QR code from a poster gave **QR code not recognised**. QR Management then showed that employee as *Scanned* with *Last scanned: Today*, and its row menu opened **View QR activity** with the day's code and the latest scans. The scan history listed both scans with who held the camera.
- The browser console showed no errors apart from the 409 that the duplicate scan is supposed to get.
- A colour fix came out of looking: white text on the light end of the brand gradient was below 4.5:1, so the gradient now runs from deep teal to a darker emerald.

The new overview query was also run **read-only against the real Supabase project** (inside a transaction that was rolled back): it returned the one tracked employee as *Not generated*, with the policy's 90 s and 5 per day.

A scripted pass against the same running API used three employee accounts, an operator and an administrator: refused location (400 m), refused reuse of a verification, a replaced code (`QR_SUPERSEDED`), an employee refused at the scanner (403), a scan that tried to send a location (400), the operator and the administrator each recording a different employee, a duplicate (409), a web address and an unknown code (422), and the dashboard totals (3 present, 3 late, 2 duplicate warnings, 4 invalid or expired warnings).

The scenarios the request lists:

| Scenario | Where |
| --- | --- |
| Admin scans from outside the office, off the office network, without any location | `daily-qr.integration.test.ts` ("records the attendance in one step, with no location and no Wi-Fi"; the scan body with `gps` is refused) |
| Employee location / Wi-Fi failures name the failing layer | "refuses without a verification, and names the layer that failed" (200 m out, off-network) |
| Different employee accounts, operator, administrator | employee, colleague, operator, tracked administrator across the file |
| Expired, replayed, replaced, duplicate, unknown, malformed, lobby and old ID codes | the *a code that is not acceptable* and duplicate / expired tests |
| One record per employee per day | duplicate and two-scanner tests; the database's own unique keys |
| Regeneration rules | supersede, daily limit, spent verification |
| Audit | `qr_attendance.recorded`, `daily_qr.generated`, no code in any log |
| Dashboard | present / late / absent, warnings, history filters |

**Not verified:**

- **A real camera and a real phone.** The web tests use a stand-in camera; nobody has scanned a real QR on screen from a real device (iOS Safari especially). An on-screen QR is a different thing to a printed one (brightness, glare, moiré). The phone layouts were checked in a desktop browser pane emulating a 375 px screen, not on a phone, so the tab bar's safe-area spacing and the bottom sheets are unconfirmed on iOS.
- **The Wi-Fi check against a real office network** (the real public address range is not known here), and **GPS accuracy on real laptops and phones**.
- **True parallel races.** "Two scanners at once" runs against a single-connection embedded database; the guarantee is the row lock and the unique indexes, reasoned and tested in sequence.
- **The real Supabase project, through the app.** The migration was rehearsed on that project first (a full generate-and-scan with its real employee and administrator rows, inside a transaction that was rolled back, nothing kept) and then applied on 2026-11-12. Nobody has yet signed in to the real app and generated a code there: that needs the real office location and network (see Operations).
- Nothing was deployed or run behind a reverse proxy. `TRUST_PROXY` must be set correctly in production or every employee appears to come from the proxy's address and the network check is meaningless or bypassable.
- Rate limits are per API instance.

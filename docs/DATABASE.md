# Database reference

Source of truth: `supabase/migrations/*.sql`, applied in filename order. The behaviour described here is covered by `apps/api/src/db/*.integration.test.ts`.

## Migrations

| File                                          | Contents                                                                                                                    |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `20261105000100_foundation.sql`               | `private` schema, default-privilege lockdown, enums, trigger helpers                                                        |
| `20261105000200_core_tables.sql`              | roles, departments, profiles, office, networks, devices, policies, holidays, leave                                          |
| `20261105000300_attendance_tables.sql`        | QR, verifications, records, events, breaks, corrections, checkout exceptions, audit, idempotency, push, notifications, announcements |
| `20261105000400_rls.sql`                      | RLS helpers, enable RLS everywhere, SELECT-only policies, grants, realtime publication                                      |
| `20261105000500_engine_functions.sql`         | check-in/out, breaks, corrections, finalization, retention (PL/pgSQL)                                                       |
| `20261105000600_reference_data_and_schedules.sql` | roles and the initial policy; `pg_cron` jobs when the extension exists                                                  |
| `20261105000700_auth_support.sql`             | `profiles.must_change_password`; lockout lookup index on `audit_logs`; hard-delete guard on `profiles`; **last-administrator trigger** (advisory-locked) |
| `20261105000800_active_user_rls.sql`          | `private.is_active_user()`; own-row policies now also require an **active** profile, so deactivation applies to the Data API and Realtime immediately |
| `20261105000900_office_verification.sql`      | QR scan outcome `VALID`; `attendance_policies.max_devices_per_employee`; unique live WebAuthn credential; **`device_challenges`** (single-use, API-only); retention now also purges spent challenges |

## Conventions

- **Time:** every instant is `timestamptz`. `work_date` is a `date` derived in the office timezone (`Asia/Kolkata` by default) by the database, never supplied by a client.
- **Soft deletion:** profiles, devices, networks and leave are deactivated/revoked/cancelled, not deleted. Attendance records, events and breaks cannot be deleted at all (triggers).
- **Append-only:** `attendance_events` and `audit_logs` reject `UPDATE`, `DELETE` and `TRUNCATE` (SQLSTATE `TG002`). Verifications and corrections only allow the narrow changes they need (consumption stamp, coordinate redaction, one decision).
- **Domain errors:** functions raise SQLSTATE `TG001` with a stable code as the message (`ALREADY_CHECKED_IN`, `ACTIVE_BREAK`, …). The code → HTTP status map lives in `packages/shared/src/errors.ts`.
- **Function lockdown:** every migration that adds functions to `private` must end with the revoke/grant block from `0005`. A test fails if any client role can execute a function outside the allowlist.
- **Dedicated DB role (production hardening):** the API connects with its own login role. That role needs `EXECUTE` on `private.*` business functions and on `private.is_valid_timezone`, plus table privileges for reads and config writes, plus `SELECT` and `DELETE` on `auth.sessions` (session checks and revocation, see [AUTH.md](AUTH.md)). A role-creation script is part of Phase 12.
- **Last administrator:** `profiles` refuses any update that would leave the system without an active administrator (`LAST_ADMIN`), whoever issues it. The first administrator is created by `npm run bootstrap:admin`.

## Business functions (schema `private`, API-only)

All take an explicit `p_now` (default `clock_timestamp()`), so the API and tests control the clock; clients can never supply it.

| Function                                                                     | Purpose                                                                                                                                             |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `check_in(employee, verification, now)`                                      | Consumes a VERIFIED, unexpired, single-use verification. Late = local time ≥ threshold. Rejects weekly off / holiday / leave. Idempotent on replay. |
| `check_out(employee, verification, now)`                                     | Computes net time, half-day, overtime, early checkout. Blocked during a break unless an admin exception exists.                                    |
| `start_break(employee, type, now)` / `end_break(employee, type?, now)`       | Lunch / short break; no overlap; optional short-break limit.                                                                                        |
| `grant_checkout_exception(employee, admin, reason, now)`                     | Admin-authorised checkout while a break is open.                                                                                                    |
| `create_correction(...)` / `decide_correction(...)` / `admin_correct(...)`   | Correction workflow. Originals are never overwritten; a `CORRECTION_APPLIED` event records before/after. Self-approval is refused.                  |
| `finalize_attendance_day(date, now)` / `finalize_due_days(now, lookback)`    | Idempotent: ABSENT, WEEKLY_OFF, HOLIDAY, ON_LEAVE, INCOMPLETE. Hourly via `pg_cron` or an external scheduler.                                       |
| `apply_retention(now, ...)`                                                  | Redacts raw coordinates after 90 days; purges QR tokens (7 d), scan events (90 d), idempotency keys (48 h). Daily.                                  |

## Running the database tests

```bash
# Embedded Postgres 17 — no Docker required
npm run test:integration -w @teachgrow/api

# Against a real local Supabase stack (needs Docker running)
npm run db:start
npm run db:reset
set TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54422/postgres   # PowerShell: $env:TEST_DATABASE_URL=...
npm run test:integration -w @teachgrow/api
```

The same command also runs the HTTP-level tests, which start a fake Supabase Auth server in-process (`apps/api/src/testing/fake-gotrue.ts`) that writes `auth.users` and `auth.sessions` into the same test database, exactly where the real service keeps them.

Local Supabase ports are shifted to 5442x (API 54421, DB 54422, Studio 54423, mail 54424) so it can run beside other Supabase projects. Self-signup is disabled; only the server creates users.

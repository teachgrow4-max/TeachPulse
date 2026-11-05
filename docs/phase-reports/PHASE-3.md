# Phase 3 report — Database, RLS, backend skeleton

Date: 2026-11-05

## Implemented

- **Monorepo** (npm workspaces): `packages/shared`, `apps/api`, `supabase/`. TypeScript strict, ESLint, Prettier.
- **Database** — 6 migrations: 14 required tables plus 8 supporting tables, 14 enums, foreign keys, unique/partial-unique/exclusion constraints, indexes, check constraints that make invalid states unrepresentable.
- **Security** — RLS on every table; client roles are SELECT-only; verification evidence, office config and audit are admin-only; no client write path anywhere; append-only events and audit log; business functions unreachable by clients.
- **Engine** — transactional PL/pgSQL for check-in, check-out, breaks, checkout exceptions, corrections (request → decision → apply, never self-approved), day finalization (idempotent), data retention.
- **API skeleton** — validated config that refuses unsafe values, strict trust-proxy parsing, security headers, CORS allowlist, rate limiting, structured logging with redaction, safe error mapping, DB pool with transactions, health/readiness.

## Files

Created: `package.json`, `tsconfig.base.json`, `eslint.config.js`, `.prettierrc.json`, `.gitignore`, `README.md`; `packages/shared/**`; `apps/api/**` (config, db, lib, middleware, routes, testing, tests); `supabase/config.toml`, `supabase/migrations/2026110500{01..06}00_*.sql`; `docs/**`.
Modified: none (greenfield). No existing project was touched.

## Database changes

All of `supabase/migrations/`. No seed users, offices, coordinates, IP ranges or employee IDs. Seeded: 3 roles, and the initial policy from the brief (10:00 / 19:00 / late 10:20 / lunch 60 min). Half-day, overtime and early-checkout ship **disabled**.

## Environment variables (`apps/api/.env.example`)

`NODE_ENV`, `PORT`, `LOG_LEVEL`, `DATABASE_URL`, `DB_SSL`, `DB_POOL_MAX`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (secret, server only), `CORS_ORIGINS`, `TRUST_PROXY`, `RATE_LIMIT_GLOBAL_PER_MIN`.

## Test results

| Suite                              | Result       |
| ---------------------------------- | ------------ |
| `packages/shared` unit             | 8 / 8        |
| `apps/api` unit                    | 63 / 63      |
| Database integration (Postgres 17) | 156 / 156    |
| Typecheck, ESLint, Prettier, build | clean        |

The 156 database tests apply every migration from scratch and cover: schema contract (enums identical to `packages/shared`), privileges, RLS isolation, write lockout, constraints, the 10:19:59 / 10:20:00 late boundary, duplicate and replayed check-in, expiry, device revocation, weekly-off/holiday/leave, net-hours maths, independent late + half-day, overtime, early checkout, policy snapshotting, break rules, checkout with an active break, corrections, finalization, retention and policy versioning.

## Decisions made during the phase

1. **DB tests run on Vitest, not pgTAP.** One TypeScript suite runs on embedded Postgres (no Docker) and, unchanged, on a real Supabase DB via `TEST_DATABASE_URL`.
2. **Policy is snapshotted at check-in.** Mid-day edits apply from the next check-in.
3. **Business functions live in a non-exposed `private` schema** and are called by the API over a direct connection, so the Data API can never invoke them.
4. **Local Supabase ports shifted to 5442x** to coexist with other Supabase projects on this machine. Self-signup disabled.

## Not verified / blockers

- **The real Supabase stack has not been started.** Docker Desktop fails to boot on this machine: it crashes at startup because a stale socket file (`%LOCALAPPDATA%\Docker\run\dockerInference`, dated 3 Aug) cannot be deleted by Windows. I tried normal deletion and reparse-point removal, then stopped rather than escalate. Consequences: `supabase start`, `supabase db reset`, the Realtime publication on a real stack, and `pg_cron` scheduling are **unverified** (the SQL for them is written; the tests ran on a Supabase-compatible emulation that skips `pg_cron`). `createDb` is covered by a mocked unit test only, not against a live server.
- At the time of this report, Phases 4–12 were not started (Phase 4 followed; see [PHASE-4.md](PHASE-4.md)).

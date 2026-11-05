# TeachGrow Attendance Management System

Employees mark attendance only after the server verifies they are physically at the TeachGrow office (GPS geofence + office network + rotating QR + registered device). Web (employee + admin) and mobile share one API, one database and one set of business rules.

**Status:** Phase 5 of 12 complete (database, RLS, attendance engine, authentication, roles and employee administration, and the four-layer office-verification engine). The check-in/out and break endpoints, the user interfaces and everything after them are not built yet. See [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md).

## Layout

```
apps/api         Express 5 + TypeScript REST API
packages/shared  Zod schemas, enums and error codes shared by api / web / mobile
supabase/        Migrations (schema, RLS, engine functions) and local stack config
docs/            Architecture, plan, auth guide, database reference, phase reports
```

`apps/web` (Vite + React) and `apps/mobile` (Expo) arrive in Phases 7 and 9.

## Prerequisites

Node 22+, npm 10+. Docker is needed only for the local Supabase stack; the whole test suite runs without it.

## Commands

```bash
npm install
npm run build                                   # shared + api
npm run typecheck && npm run lint && npm run format:check
npm test                                        # unit tests (no database)
npm run test:integration -w @teachgrow/api      # database + HTTP tests on embedded Postgres 17
```

## Running the API

1. Copy `apps/api/.env.example` to `apps/api/.env` and fill in real values. Environment variables are validated at startup; the process refuses to boot on a missing or unsafe one.
2. Start Supabase (`npm run db:start`) or point the file at your hosted project.
3. Create the first administrator, once: `npm run bootstrap:admin -w @teachgrow/api` (see [docs/AUTH.md](docs/AUTH.md)).
4. `npm run dev:api`

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — design decisions and security model
- [Authentication guide](docs/AUTH.md) — sessions, roles, CSRF, lockout, client contracts, limits
- [Office verification](docs/VERIFICATION.md) — GPS, office network, rotating QR and device layers; what each does and does not prove
- [Implementation plan](docs/IMPLEMENTATION_PLAN.md) — phases, open decisions, external prerequisites
- [Database reference](docs/DATABASE.md) — migrations, functions, conventions, how to test
- Phase reports: [Phase 3](docs/phase-reports/PHASE-3.md), [Phase 4](docs/phase-reports/PHASE-4.md), [Phase 5](docs/phase-reports/PHASE-5.md)

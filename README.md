# TeachGrow Attendance Management System

Employees mark attendance only after the server verifies they are physically at the TeachGrow office (GPS geofence + office network + rotating QR + registered device). Web (employee + admin) and mobile share one API, one database and one set of business rules.

**Status:** Phase 5 of 12 complete (database, RLS, attendance engine, authentication, roles and employee administration, and the four-layer office-verification engine). The check-in/out and break endpoints, the user interfaces and everything after them are not built yet. See [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md).

**Also in the repository:** QR attendance (an employee generates a short-lived QR code once the server has checked their location and office network; an administrator or attendance operator scans it, from anywhere, and the attendance is recorded) with an attendance dashboard, and the first slice of the web app that goes with it. See [docs/ADMIN_QR_ATTENDANCE.md](docs/ADMIN_QR_ATTENDANCE.md).

## Layout

```
apps/api         Express 5 + TypeScript REST API
apps/web         Vite + React + Tailwind web app (so far: sign-in, profile with QR code, QR scanner, QR management)
packages/shared  Zod schemas, enums and error codes shared by api / web / mobile
supabase/        Migrations (schema, RLS, engine functions) and local stack config
docs/            Architecture, plan, auth guide, database reference, phase reports
```

The rest of `apps/web` (employee dashboard, administrator dashboard) arrives in Phases 7 and 8, and `apps/mobile` (Expo) in Phase 9.

## Prerequisites

Node 22+, npm 10+. Docker is needed only for the local Supabase stack; the whole test suite runs without it.

## Commands

```bash
npm install
npm run build                                   # shared + api
npm run typecheck && npm run lint && npm run format:check
npm test                                        # unit tests (no database)
npm run test:integration -w @teachgrow/api      # database + HTTP tests on embedded Postgres 17
npm run test -w @teachgrow/web                  # web app unit and component tests
npm run build -w @teachgrow/web                 # production build of the web app
```

## Running the API

1. Copy `apps/api/.env.example` to `apps/api/.env` and fill in real values. Environment variables are validated at startup; the process refuses to boot on a missing or unsafe one.
2. Start Supabase (`npm run db:start`) or point the file at your hosted project.
3. Create the first administrator, once: `npm run bootstrap:admin -w @teachgrow/api` (see [docs/AUTH.md](docs/AUTH.md)).
4. `npm run dev:api`

## Trying the web app without Supabase

```bash
npm run build:shared
npx tsx apps/api/src/testing/dev-server.ts      # demo API on :4000 with invented people; embedded Postgres, no Docker
npm run dev -w @teachgrow/web                   # http://localhost:5173 (proxies /api to :4000)
```

The demo prints the sign-in details. It is for trying things out only: never point it at real data.

## Hosting the API

The repository root is the project root (it is an npm workspace), so a host must install, build and start from the root:

| Setting       | Value |
| ------------- | ----- |
| Node.js       | 22 or newer |
| Install       | `npm install`. The root `.npmrc` keeps the build tools (TypeScript and the type packages) installed even when the host sets `NODE_ENV=production`, which would otherwise skip them and fail the build with "tsc: command not found" |
| Build command | `npm run build` (the shared package, then the API) |
| Start command | `npm start`, which runs `apps/api/dist/server.js`. Use that file if the host asks for an entry file |
| Environment   | `NODE_ENV=production` plus every variable in `apps/api/.env.example`, set in the host's dashboard. The process refuses to boot on a missing or unsafe value and names it |
| Database      | For Supabase use the **Session pooler** connection string (IPv4) as `DATABASE_URL`, `DB_SSL=true`, and paste Supabase's database certificate (dashboard, Project Settings, Database, SSL Configuration) into `DB_SSL_CA`. Apply the migrations from a clean checkout of `main` before first use. `GET /api/health/ready` answers 200 only when the database connection works |

The API needs a Postgres/Supabase project it can reach. The web app is a static build: `npm run build -w @teachgrow/web` writes `apps/web/dist`. Serve it from the same site as the API, over https and with the headers listed in [docs/ADMIN_QR_ATTENDANCE.md](docs/ADMIN_QR_ATTENDANCE.md) (the browser only allows the camera and location on secure pages). The rest of the web app and the mobile app arrive in Phases 7 to 9.

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — design decisions and security model
- [Authentication guide](docs/AUTH.md) — sessions, roles, CSRF, lockout, client contracts, limits
- [Office verification](docs/VERIFICATION.md) — GPS, office network, rotating QR and device layers; what each does and does not prove
- [Admin-operated QR attendance](docs/ADMIN_QR_ATTENDANCE.md) — employee-generated QR codes, the admin scanner, the attendance dashboard, how it reuses the attendance engine, threat model, what was and was not verified
- [Implementation plan](docs/IMPLEMENTATION_PLAN.md) — phases, open decisions, external prerequisites
- [Database reference](docs/DATABASE.md) — migrations, functions, conventions, how to test
- Phase reports: [Phase 3](docs/phase-reports/PHASE-3.md), [Phase 4](docs/phase-reports/PHASE-4.md), [Phase 5](docs/phase-reports/PHASE-5.md), [Admin QR attendance](docs/phase-reports/ADMIN-QR-ATTENDANCE.md)

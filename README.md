# LUMA

LUMA is a multi-tenant SaaS platform for salons, beauty centres and independent beauty experts. Each business gets an isolated workspace with its own data, team, catalog, storefront and brand identity. A customer has one central LUMA account across businesses; each business sees only its own relationship with her. The product is bilingual: Arabic (right-to-left, the default) and English.

> **Private review build.** This delivery is not a production service.
>
> - **No real payments.** The only connected payment provider is the **LUMA Sandbox**, a simulation that moves no money. Moyasar, Tap, Tabby and Tamara are listed in the provider catalog but are not integrated (`src/server/domains/payments/providers/registry.ts`).
> - **No real messages or campaigns are sent.** No email, SMS or WhatsApp provider is connected. In development, messages go to a clearly labelled dev outbox; campaigns on those channels record *simulated* deliveries, or refuse to start when the channel is disconnected. In-app notifications are the only channel that reaches people.
> - **AI is disconnected** unless both `OPENAI_API_KEY` and `OPENAI_MODEL` are set. Without them, AI features report "disconnected" and the manual and rules-based flows keep working.
> - **Demo mode and the dev OTP echo are forced off when `APP_ENV=production`**, whatever `DEMO_MODE` / `DEV_OTP_ECHO` say (`src/server/env.ts`).
> - Plan prices are unset (`NULL`, "pricing not configured") and plan limits are test values.

## Stack

| Layer | Choice |
|---|---|
| Web | Next.js 16 (App Router), React 19, TypeScript 5.9 |
| Data | PostgreSQL 16 with row-level security, Kysely 0.29 (query builder), `pg` |
| Validation | Zod 4 |
| UI | Tailwind CSS 4, lucide-react icons, TanStack Query |
| Background work | `scripts/worker.ts` on Postgres tables (`job_runs`, `outbox_events`); no Redis |
| Tests | Vitest 4 (unit and integration against a real Postgres), Playwright 1.56 (E2E) |
| Package manager | pnpm 10 (`packageManager: pnpm@10.28.0`) |

Next.js 16 renamed `middleware.ts` to `proxy.ts`. The repo's `src/proxy.ts` only adds an `x-pathname` header for server components. See `AGENTS.md` before you change framework code.

## Prerequisites

- Node.js 22 or newer (`engines.node: ">=22"`).
- pnpm 10.
- PostgreSQL 16 with the `pgcrypto`, `btree_gist` and `citext` extensions available. Migration `0001` runs `create extension if not exists` for all three. They are trusted extensions in PostgreSQL 13+, so the database owner can create them. Otherwise a superuser must create them once.
- Optional: a Chromium binary for PDF receipts (`playwright-core`; set `CHROMIUM_EXECUTABLE` if it is not in the default location). Without one, the PDF endpoint returns 503 and the printable HTML view still works. The Playwright browsers are needed for `pnpm test:e2e`.

## Database roles

LUMA uses two roles. The split is part of the security model.

| Role | Used by | Purpose |
|---|---|---|
| `luma_owner` | `DATABASE_OWNER_URL`: migrations, seed, reset and bootstrap scripts | Owns the schema, tables and `SECURITY DEFINER` functions. |
| `luma_app` | `DATABASE_URL`: the Next.js server and the worker | Runtime role. It is **not** the table owner, not a superuser and has no `BYPASSRLS`, so row-level security always applies. Migrations grant it DML on tables (minus `UPDATE`/`DELETE` on append-only ledgers) and execute on `app.*` functions. |

Creating the roles and databases is in [docs/RUNBOOK.md](docs/RUNBOOK.md#database-roles-and-extensions).

## Setup

```bash
pnpm install
cp .env.example .env          # then fill in the values (see docs/RUNBOOK.md)
pnpm db:migrate               # applies db/migrations/*.sql as DATABASE_OWNER_URL
pnpm db:seed                  # fictional demo data; refuses to run in production
pnpm dev                      # http://localhost:3000
pnpm worker                   # in a second terminal: jobs, outbox, sweepers
```

- `.env` must set at least `APP_ENV`, `APP_URL`, `DATABASE_URL` (as `luma_app`), `DATABASE_OWNER_URL` (as `luma_owner`) and `AUTH_SECRET` (32 or more characters).
- To sign in during development, set `DEV_OTP_ECHO=true`. Verification codes are then shown on screen and written to the dev outbox. With no provider and no echo, registration returns 503 rather than pretending a code was sent.
- The seed writes one random password per demo account to **`.demo-credentials.txt`**. That file is gitignored and created with mode `0600`. Never commit it or copy it into documents.
- To give an existing, verified account the first `platform_owner` role, run `pnpm exec tsx scripts/grant-platform-role.ts --email <email> --role platform_owner --reason "<why>"`.

## Tests

| Command | What it runs | Database |
|---|---|---|
| `pnpm test` | Vitest unit and integration tests (`tests/unit`, `tests/integration`). Files run serially. | `TEST_DATABASE_URL` / `TEST_DATABASE_OWNER_URL` (default `luma_test`). Global setup migrates the database and truncates it, and refuses any name that does not end in `_test`. |
| CI | `.github/workflows/ci.yml` runs on every PR and push to `main`: typecheck, lint, Vitest against a PostgreSQL 16 service container, `next build`, then the Playwright journeys. | Throwaway service databases created by the workflow. |
| `pnpm test:e2e` | Playwright journeys (`tests/e2e`). Builds and starts the app (`next build && next start`, build dir `.next-e2e`) on port 3110 (`E2E_PORT`). | `luma_e2e` (`E2E_DATABASE`; must end in `_e2e` and be local). Global setup drops and recreates its schemas, migrates and seeds. An operator creates the database once. |
| `pnpm typecheck` | `tsc --noEmit` | none |
| `pnpm lint` | ESLint | none |

Example run against a scratch database:

```bash
TEST_DATABASE_URL=postgres://luma_app:<password>@localhost:5432/luma_x_test \
TEST_DATABASE_OWNER_URL=postgres://luma_owner:<password>@localhost:5432/luma_x_test \
pnpm exec vitest run
```

The coverage map and the latest observed results are in [docs/TEST_PLAN.md](docs/TEST_PLAN.md).

## Project layout

```
db/migrations/        forward-only SQL migrations (checksummed; never edit an applied file)
scripts/              migrate, seed, reset-dev, worker, grant-platform-role, gen-db-types.sh
src/proxy.ts          Next 16 proxy (adds x-pathname)
src/app/              pages and /api/v1 route handlers (thin)
src/server/           server-only code
  env.ts              validated environment
  boot.ts             cross-domain hook wiring (once per process)
  db/                 Kysely client, withTenant/withSystem/withCentral, migrator, generated types
  http/               route() wrapper, errors, params
  auth/               sessions, passwords/OTP, capabilities
  tenancy/            tenant access resolution, plan entitlements and limits
  infra/              audit, idempotency, outbox, rate limit, storage, messaging, notify, pdf, ai/
  jobs/               registry, runner, maintenance
  domains/<name>/     business logic (booking, payments, finance, builder, marketing, policy, ...)
src/shared/           isomorphic code: zod schemas, builder registry, theme, plans, formatting
src/ui/               client components (design system, shells, feature UIs)
src/i18n/             ar/en dictionaries
tests/unit|integration|e2e|helpers|setup
```

## Documentation

| Document | Contents |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Runtime topology, request lifecycle, isolation, conventions |
| [docs/DATA_MODEL.md](docs/DATA_MODEL.md) | Tables by domain, constraints, RLS model, definer functions |
| [docs/PERMISSIONS.md](docs/PERMISSIONS.md) | Roles, capability matrix, support access, step-up, MFA, plan gating |
| [docs/BOOKING_ENGINE.md](docs/BOOKING_ENGINE.md) | Availability algorithm, holds, concurrency, lifecycle, rescheduling |
| [docs/PAYMENT_FLOW.md](docs/PAYMENT_FLOW.md) | Payment terms, sandbox provider, webhooks, refunds, journal |
| [docs/BUILDER_SCHEMA.md](docs/BUILDER_SCHEMA.md) | Storefront blocks, theme, validation, publishing, assistant |
| [docs/AI_AND_MARKETING.md](docs/AI_AND_MARKETING.md) | AI adapter, Loom Marketing, trends, campaigns, analytics |
| [docs/TEST_PLAN.md](docs/TEST_PLAN.md) | Coverage map and observed results |
| [docs/RUNBOOK.md](docs/RUNBOOK.md) | Environment, operations, incidents, production checklist |
| [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md) | Status per spec area, gaps, external blockers |
| [docs/PROGRESS.md](docs/PROGRESS.md) | Decisions log and hand-off notes |

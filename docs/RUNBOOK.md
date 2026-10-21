# Runbook

Operational reference for running LUMA. Values shown are placeholders: never copy real secrets from `.env` or `.demo-credentials.txt` into documents, tickets or chat.

## Environment variables

Parsed and frozen by `src/server/env.ts`. Empty strings are treated as unset. An invalid environment throws on first use with the list of issues.

| Variable | Required | Default | Notes |
|---|---|---|---|
| `APP_ENV` | yes | `development` | `development`, `test` or `production`. `production` forces `demoEnabled` and `devOtpEcho` to false, makes cookies `Secure`, and disables the sandbox simulation endpoints, the dev outbox route, `reset-dev`, `seed` and the E2E setup. |
| `APP_URL` | yes | `http://localhost:3000` | Public base URL; also the allowed CSRF `Origin` |
| `DATABASE_URL` | yes | — | Runtime connection as **`luma_app`** (non-owner, so RLS applies) |
| `DATABASE_OWNER_URL` | scripts | — | Owner connection (`luma_owner`) for migrate, seed, reset and grant-platform-role |
| `DB_APP_ROLE` | no | `luma_app` | Runtime role that migrations grant to (pattern `^[a-z_][a-z0-9_]*$`) |
| `AUTH_SECRET` | yes | — | At least 32 characters. HMAC key for session, preview, invite and gift-card hashes, and the HKDF source for the MFA secret encryption key. Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. **Rotating it invalidates sessions, tokens, gift-card codes and enrolled MFA secrets.** |
| `DEMO_MODE` | no | false | Demo role switcher on the login page (seeded demo users only). Forced off in production. |
| `DEV_OTP_ECHO` | no | false | Shows one-time codes on screen and in `dev_message_outbox`; campaigns on email/SMS/WhatsApp become `dev_simulation`. Forced off in production. |
| `STORAGE_DRIVER` | no | `local` | Only `local` exists |
| `STORAGE_LOCAL_DIR` | no | `./storage` | Local file storage root (gitignored) |
| `EMAIL_PROVIDER`, `SMS_PROVIDER`, `WHATSAPP_PROVIDER` | no | `none` | Only `none` is accepted; no provider is integrated |
| `OPENAI_API_KEY`, `OPENAI_MODEL` | no | empty | AI is connected only when **both** are set |
| `OPENAI_BASE_URL` | no | `https://api.openai.com/v1` | — |
| `OPENAI_PRICE_INPUT_PER_MTOK`, `OPENAI_PRICE_OUTPUT_PER_MTOK` | no | unset | USD per 1M tokens, used for `ai_runs.cost_usd_micros`; `NULL` when unset |
| `AI_REQUEST_TIMEOUT_MS` | no | 45000 | — |
| `PAYMENT_SANDBOX_WEBHOOK_SECRET` | for the sandbox | empty | HMAC secret for sandbox webhooks; at least 16 characters, or sandbox calls throw |

Read directly from `process.env` (not in `.env.example`):

| Variable | Used by |
|---|---|
| `DB_POOL_MAX` (default 10) | `src/server/db/client.ts` pool size. The statement timeout is fixed at 15 s. |
| `CHROMIUM_EXECUTABLE` | `src/server/infra/pdf.ts` (PDF receipts) |
| `SEED_CREDENTIALS_JSON` | `scripts/seed.ts`: write credentials as JSON to this path instead of `.demo-credentials.txt` (used by E2E) |
| `TEST_DATABASE_URL`, `TEST_DATABASE_OWNER_URL` | Vitest (default database `luma_test`) |
| `E2E_DATABASE` (default `luma_e2e`), `E2E_PORT` (default 3110) | `playwright.config.ts` |
| `NEXT_DIST_DIR` | `next.config.ts` (the E2E server uses `.next-e2e`) |

## Database roles and extensions

The runtime role must **not** own the tables and must not be a superuser or have `BYPASSRLS`; otherwise row-level security does not apply. As a superuser:

```sql
create role luma_owner login password '<owner-password>';
create role luma_app   login password '<app-password>' nosuperuser nobypassrls nocreatedb nocreaterole;

create database luma_dev owner luma_owner;
grant connect on database luma_dev to luma_app;

-- Optional: create extensions up front (migration 0001 also runs CREATE EXTENSION IF NOT EXISTS;
-- pgcrypto, btree_gist and citext are trusted extensions, so the database owner can create them).
\c luma_dev
create extension if not exists pgcrypto;
create extension if not exists btree_gist;
create extension if not exists citext;
```

On PostgreSQL 15+, the `public` schema is owned by the database owner. Migrations grant `luma_app` DML on all tables (`apply_conventions`), revoke `UPDATE`/`DELETE` on append-only tables, revoke all access to `schema_migrations`, and grant `EXECUTE` on `app.*` functions. Repeat the `create database … owner luma_owner` and `grant connect` steps for the test (`*_test`) and E2E (`*_e2e`) databases.

## Migrations

```bash
pnpm db:migrate          # tsx scripts/migrate.ts, as DATABASE_OWNER_URL
```

- Applies `db/migrations/*.sql` in **lexical** order, each in its own transaction, and records `filename` and SHA-256 `checksum` in `schema_migrations`.
- **Checksums**: an already-applied file whose content changed aborts the run with "Migration X was modified after being applied. Create a new migration instead." Never edit an applied migration; add a new file.
- **Advisory lock**: `pg_advisory_lock(727274)` serialises concurrent runners (parallel test workers, two deploys).
- `{{APP_ROLE}}` in SQL is replaced with `DB_APP_ROLE`.
- Forward-only: nothing in the migrator drops data. After schema changes, regenerate types with `./scripts/gen-db-types.sh` (reads `DATABASE_OWNER_URL` from `.env`).

## Seeding and the guarded dev reset

```bash
pnpm db:seed                                 # refuses APP_ENV=production
pnpm db:reset-dev --confirm=<database-name>  # then pnpm db:seed
```

- The **seed** (`scripts/seed.ts`) creates clearly fictional data: a platform owner and a policy reviewer; "Noura Salon" (`noura-salon`, Wahaj plan) with manager, receptionist, specialist and finance members, services, staff, customers (including one with an experimental `require_full_payment` decision), weeks of history with consistent payments, expenses with deliberately missing costs, products, an incident under review, an appeal, an example marketing plan and a published storefront; and "Lamar Makeup" (`lamar-makeup`, Sanaa plan). Demo users are flagged `is_demo`. Each gets a **unique random password** written to `.demo-credentials.txt` (gitignored, mode `0600`), or to `SEED_CREDENTIALS_JSON`. Re-running skips if the demo owner exists, unless `--force-new-slugs` is passed.
- The **reset** (`scripts/reset-dev.ts`) drops and recreates the `app` and `public` schemas, then re-migrates. Guards: refuses `APP_ENV=production` or `NODE_ENV=production`; the database name **must end in `_dev`**; the host must be `localhost`, `127.0.0.1` or `::1`; and `--confirm=<exact database name>` must be given.

## Bootstrapping the first platform owner

The account must already exist, be active and have a verified email or phone.

```bash
pnpm exec tsx scripts/grant-platform-role.ts --email <email> --role platform_owner --reason "initial bootstrap"
pnpm exec tsx scripts/grant-platform-role.ts --phone <+9665XXXXXXXX> --role support_admin
pnpm exec tsx scripts/grant-platform-role.ts --email <email> --role support_admin --revoke
```

- Roles: `platform_owner`, `support_admin`, `policy_reviewer`, `technical_admin`.
- The script uses `DATABASE_OWNER_URL` and audits the change with `actor_kind = 'system'`. It refuses to revoke the last `platform_owner`.
- Afterwards, platform owners manage roles in `/platform/users` (step-up, audited). Ask every admin to enrol MFA at `/platform/security`; it is not enforced automatically.

## Background worker

```bash
pnpm worker      # tsx scripts/worker.ts; stops on SIGTERM/SIGINT
```

Each loop runs `runPeriodic()`, then `runOutbox()` (up to 50 events), then `runDueJobs()` (up to 10 jobs). It sleeps 2 s when idle and 5 s after an error.

- **Jobs** (`job_runs`) are claimed with `FOR UPDATE SKIP LOCKED`, so several workers are safe. Exponential backoff is `min(1800, 2^attempt × 15)` s plus up to 10 s jitter. A job is `failed` after `max_attempts` (default 5) or on `PermanentJobError`. A job kind with no handler fails permanently. `dedupe_key` is unique.
- **Outbox** (`outbox_events`) is at-least-once: claiming pushes `available_at` 5 minutes ahead, and failures back off. Delivery stops after 10 attempts. Events whose topic has no handler are acknowledged without action.
- **Periodic tasks** run in-process. Their last-run times are kept **in memory per worker**, so with several workers each task runs in each of them. The tasks are idempotent, but run a single worker unless that is acceptable.

Registered work (from `registerJob` / `registerOutbox` / `registerPeriodic`):

| Kind | Name | Interval / trigger | What it does |
|---|---|---|---|
| job | `analytics.rollup` | on demand (`POST analytics/rollup`) | Recompute `daily_metrics` for given days |
| job | `marketing.ai_job` | `requestAiJob` | Run a Loom AI job |
| job | `marketing.campaign_send` | scheduled campaign | Send (or defer) a campaign |
| job | `marketing.trend_fetch` | on demand | Fetch the tenant's trend sources |
| outbox | `booking.confirmed`, `booking.cancelled`, `booking.rescheduled`, `booking.reminder` | enqueued by booking code | Transactional messages through the messaging adapter (simulated or unavailable without a provider) |
| periodic | `expire-idempotency-and-rate-limits` | 3600 s | Delete expired idempotency records, rate-limit buckets older than 1 day, verification codes expired more than 7 days ago |
| periodic | `booking.expire-holds` | 30 s | Expire holds past `hold_expires_at` |
| periodic | `booking.reminders-24h` | 900 s | Enqueue 24-hour reminders once per booking |
| periodic | `payments.reconcile` | 21600 s (6 h) | Reconcile tenants with recent provider payments |
| periodic | `waitlist.expire-offers` | 60 s | Expire offers and pass them to the next candidate |
| periodic | `loyalty.expire-inactive` | 21600 s | Expire points after inactivity |
| periodic | `giftcards.expire` | 3600 s | Expire gift cards (breakage posting) |
| periodic | `memberships.expire` | 3600 s | Expire memberships past `ends_at` |
| periodic | `commerce-expire-orders` | 60 s | Cancel unpaid orders past `expires_at`; release stock once |
| periodic | `commerce-abandon-carts` | 3600 s | Mark idle open carts abandoned |
| periodic | `policy-decisions-sweep` | 300 s | Expire decisions; flag `review_at` once |
| periodic | `subscriptions-lifecycle` | 300 s | Trial end → past_due (grace) → expired; scheduled cancellations; test-mode period roll-over |
| periodic | `subscriptions-usage-counters` | 3600 s | Usage snapshots and `overage_state` refresh |
| periodic | `analytics.daily-rollup` | 3600 s | Fan out rollups to tenants with recent storefront activity |
| periodic | `marketing.scheduler` | 3600 s | Enqueue scheduled weekly and monthly Loom jobs at the business's local time |

Note the naming styles differ (`commerce-expire-orders` vs `booking.expire-holds`); use the names exactly as listed when searching logs.

## Health endpoint

`GET /api/v1/health` returns `200 {"ok":true,"db":"up"}` after a `select 1` against `DATABASE_URL`, or `503 {"ok":false,"db":"down"}`. It sends `Cache-Control: no-store`, reveals no configuration, and needs no authentication. Playwright waits on it before running E2E tests. It does **not** check the worker.

## E2E database

`pnpm test:e2e` uses a dedicated database, by default `luma_e2e` (`E2E_DATABASE`). An operator must create it **once** (owner `luma_owner`, `grant connect` to `luma_app`). Each run's global setup refuses names not ending in `_e2e`, non-local hosts and `APP_ENV=production`. It then drops and recreates the `app` and `public` schemas, migrates and seeds. The dev server runs on port 3110 with `NEXT_DIST_DIR=.next-e2e`, `DEV_OTP_ECHO=true` and `DEMO_MODE=false`. The role passwords for this database are set in `playwright.config.ts` and must match the local roles.

## Backups

**Nothing in this repository automates backups.** Recommended operator procedure for any non-disposable database:

- Take scheduled logical backups as the owner role, for example `pg_dump --format=custom --no-owner --file=<path> <database>`, or use the hosting provider's point-in-time recovery.
- Back up `STORAGE_LOCAL_DIR` (uploaded assets, private evidence, exports) at the same time. Database rows reference `storage_key`s in that directory.
- Keep `AUTH_SECRET` in the secret store alongside the backups. Without it, restored session, preview and invite hashes, gift-card codes and encrypted MFA secrets cannot be used.
- To restore, create the roles first, restore into an empty database owned by `luma_owner`, then run `pnpm db:migrate` (it should report "database is up to date").
- Rehearse restores. Do not restore production data into `_dev`, `_test` or `_e2e` databases without anonymising it.

## Incident procedures

### Payment webhook failures

1. Inspect intake: `select provider, event_type, status, error, received_at from provider_events where status in ('failed', 'needs_review') or signature_valid = false order by received_at desc;`. Rejected signatures are stored as `ignored` with `signature_valid = false`.
2. Flagged payments: `select id, tenant_id, status, reconciliation_note from payments where needs_reconciliation order by updated_at desc;`. Finance and refund approvers are notified in-app when a payment is flagged.
3. Run reconciliation for the business: `POST /api/v1/t/{slug}/payments/reconcile` (needs `finance.view`), or wait for the 6-hourly `payments.reconcile`. It applies captures whose webhook was lost, expires stale pending payments, and records a `reconciliation_runs` row listing discrepancies.
4. A "captured after closed/cancelled" or "late success, slot taken" payment is refunded automatically. Confirm the refund reached `succeeded`.
5. If the webhook secret changed, update `PAYMENT_SANDBOX_WEBHOOK_SECRET` and restart. Events signed with the old secret are rejected; the timestamp tolerance is 300 s.

### Stuck jobs

There is **no automatic reclamation** of jobs left `running` by a crashed worker.

1. Find them: `select id, kind, tenant_id, attempts, locked_by, locked_at, last_error from job_runs where status = 'running' and locked_at < now() - interval '30 minutes';`. The platform integrations view (`/platform/integrations`, `GET /api/v1/platform/integrations`) also shows queued, running and failed counts by job kind.
2. Make sure the worker in `locked_by` is really gone, then requeue: `update job_runs set status = 'queued', locked_by = null, locked_at = null, run_at = now() where id = '<id>';` (run as the owner role in system context).
3. Failed jobs: read `last_error`, fix the cause, then requeue the same way. Loom AI jobs can be retried from the UI (`POST marketing/jobs/{id}/retry`).
4. Outbox: `select topic, attempts, last_error from outbox_events where processed_at is null order by created_at;`. Events stop after 10 attempts. Fix the cause, then reset `attempts`/`available_at` if delivery is still wanted.

### Revoking a support grant

- Platform UI `/platform/support`, or `POST /api/v1/platform/support-grants/{id}/revoke` with an optional `{ "reason": "…" }`. The grant holder can end their own grant; a `platform_owner` can revoke any grant. The business owner is notified and the action is audited.
- Emergency: suspending the support user's account (below) also revokes all their active grants and sessions.

### Suspending a tenant or an account

- **Business**: `POST /api/v1/platform/tenants/{id}/status` with `{ "status": "suspended", "reason": "<at least 10 characters>" }` (`platform.tenants.manage`, step-up). Members of a suspended business get no capabilities and the workspace is read-only; data is kept, and the owner is notified. Reinstate with `"status": "active"` (the tenant returns to `active`, or to `onboarding` if never published).
- **Account**: `POST /api/v1/platform/users/{id}/status` with `{ "status": "suspended", "reason": "…" }` (`platform.users.manage`, step-up). This revokes all sessions and active support grants. You cannot suspend yourself or the last active platform owner.
- **Customer restriction** (not an account suspension): a platform `suspend_account` policy decision blocks payment for that customer at every business. It needs a policy reviewer, the platform-owner rule for suspension, and step-up.

## Production security checklist

- [ ] `APP_ENV=production`. This forces `DEMO_MODE` and `DEV_OTP_ECHO` off, makes cookies `Secure`, and disables the sandbox simulation routes, the dev outbox, seed and reset. Do not run `pnpm db:seed` against production; it refuses anyway.
- [ ] Secrets (`AUTH_SECRET`, database passwords, `PAYMENT_SANDBOX_WEBHOOK_SECRET`, `OPENAI_API_KEY`) live in a secret manager, never in the repository, images or logs. `AUTH_SECRET` has at least 32 random bytes and differs per environment.
- [ ] TLS terminates in front of the app; `APP_URL` is the `https://` origin. HSTS is set at the proxy (the app does not set it). The app sets CSP, `X-Content-Type-Options`, `Referrer-Policy` and `Permissions-Policy` in `next.config.ts`.
- [ ] The database connection uses TLS. `DATABASE_URL` uses the non-owner `luma_app` role, and the owner credentials are available only to the migration job.
- [ ] **No shared passwords**: each operator has a personal account, platform roles are granted individually, and every platform admin enrols TOTP MFA (not enforced by code). No demo (`is_demo`) accounts or demo businesses exist in production.
- [ ] **Provider credentials need approval**: real payment (Moyasar, Tap, Tabby, Tamara), messaging and AI providers are **not integrated**. Each needs a merchant or provider agreement, verified credentials, an adapter (`PaymentProvider` / `MessageProvider`) and review before use. Do not connect the sandbox provider for real businesses: `connectSandbox` has no production gate.
- [ ] Only one worker runs, or periodic task duplication is acceptable.
- [ ] Backups and restore rehearsals are in place (see above).
- [ ] Log retention excludes request bodies. Audit logs store redacted metadata only.

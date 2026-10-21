# LUMA — Architecture

LUMA is a multi-tenant SaaS for salons, beauty centers and independent beauty experts. LUMA manages subscriptions and central accounts; each business gets an isolated workspace, data, storefront and brand identity. A customer has one central LUMA account across businesses, while each business only sees its own relationship with her.

## 1. Runtime topology

```
Browser ──► Next.js 16 (App Router)
             ├─ Server components (pages, storefront rendering)
             ├─ Route handlers  /api/v1/**  (all reads/writes; JSON envelope)
             └─ proxy.ts        (adds x-pathname only)
          ──► PostgreSQL 16  (single source of truth; RLS; exclusion constraints)
Worker (scripts/worker.ts) ──► job_runs (retries/backoff/dedupe), outbox_events, periodic sweepers
Object storage adapter (local driver in dev) ──► /api/v1/media/:id (authorised streaming)
External adapters (honest status): messaging (none → dev outbox), AI (OpenAI Responses), payments (LUMA Sandbox)
```

No Redis: rate limits, idempotency, queues and locks live in Postgres (`rate_limit_buckets`, `idempotency_records`, `job_runs` with `FOR UPDATE SKIP LOCKED`, advisory locks). Add infrastructure only when measurements justify it.

## 2. Source layout

```
db/migrations/           forward-only SQL migrations (checksummed; never edit an applied file)
scripts/                 migrate, seed, worker, type generation, CLI tools
src/app/                 Next.js routes (pages + /api/v1 route handlers — thin)
src/server/              server-only code
  env.ts                 validated environment (demo/dev switches forced off in production)
  db/                    Kysely client, scoped transactions, generated schema types
  http/                  route() wrapper, errors, param helpers
  auth/                  sessions, passwords/OTP, capabilities (permission model)
  tenancy/               tenant access resolution, plan entitlements/limits
  infra/                 audit, idempotency, outbox, rate limit, storage, messaging, notify, ai/
  jobs/                  registry + runner; each domain registers handlers
  domains/<name>/        domain services (business logic; no React, no HTTP)
src/shared/              isomorphic code: zod schemas, builder block registry, formatting, plans
src/ui/                  client components: design system, shells, feature UIs
src/i18n/                ar/en dictionaries (one file per domain), server/client helpers
tests/unit|integration/  vitest; integration tests hit a real Postgres test database
```

Rule of thumb: **route handlers are thin** (parse → call a domain service → return). Booking, payment, policy and AI logic never lives in components or route files.

## 3. Request lifecycle (`src/server/http/route.ts`)

Every API endpoint is declared with `route({...})`:

1. `x-request-id` assigned/propagated.
2. CSRF: mutations require header `x-luma-csrf: 1` and a same-origin `Origin` (cookies are `SameSite=Lax`, `HttpOnly`, `Secure` in production).
3. Auth mode: `public | optional | user | tenant | platform`.
4. Verified-contact requirement (`requireVerified`) and step-up (`stepUp`) where sensitive.
5. Rate limit (`rateLimit`).
6. Tenant routes (`/api/v1/t/[tenantSlug]/…`): `resolveTenantAccess(user, slug)` derives scope from the caller's **own** membership (or a time-limited support grant). Unknown slugs and non-member slugs both return the same 404. Then `capability` (any-of), plan `feature`, and read-only workspace checks.
7. Input validated with zod (`input`: body for mutations, query for GET). Unknown fields are rejected where schemas are `.strict()`.
8. Handler returns `{ data, status?, meta? }` → `{"data": …}`; errors → `{"error": {code, message, details, request_id}}` with 401/403/404/409/422/429/503.

Path ids are validated with `requireUuidParam` before touching the DB.

## 4. Tenant isolation (defence in depth)

- Every business-owned table has `tenant_id`; children reference parents by **composite** `(tenant_id, id)` foreign keys, so a service can never point at another tenant's staff, an order item at another tenant's variant, etc.
- **Row-level security** on every `tenant_id` table (`app.apply_conventions()` in each migration). The runtime DB role (`luma_app`) is not the table owner, so policies always apply.
- Services run tenant work inside `withTenant(tenantId, trx => …)`, which sets `app.tenant_id` for the transaction. A query that forgets its `WHERE tenant_id` still sees only that tenant.
- `withSystem(reason, …)` is the only cross-tenant scope (platform admin, webhook intake before tenant resolution, job fan-out). Each use states a reason.
- Cross-tenant *reads for a specific purpose* use `SECURITY DEFINER` functions in schema `app` returning allowlisted columns: `resolve_tenant_slug`, `memberships_for_user`, `invitation_by_token`, `customer_bookings`, `customer_orders`, `notifications_for_user`, `asset_for_serving`, `platform_decisions_for_customer` (actions only), `preview_token_tenant`.
- Rows with `tenant_id NULL` (platform-level audit events, notifications, jobs) may be inserted from any scope but read only via system scope or definer functions.
- Jobs carry `tenant_id` and re-enter `withTenant` themselves. AI calls are per tenant; caches are keyed by tenant.

## 5. Permissions

See `PERMISSIONS.md`. Capabilities are defined in `src/server/auth/capabilities.ts` (role defaults + per-role **delegable allowlists**; owner-only capabilities can never be delegated). UI hides what you cannot do; the server enforces it regardless.

## 6. Data conventions

- UUID primary keys; `created_at/updated_at` (trigger-maintained); actors recorded where it matters.
- Money: `bigint` minor units (halalas) + `currency`. Inventory quantities: `numeric(14,3)`.
- Instants: `timestamptz` (UTC). Wall-clock schedule times: `time` in the branch timezone (default `Asia/Riyadh`). Calendar dates: `date`, returned as `'YYYY-MM-DD'` strings (never shifted through JS timezones).
- Snapshots at transaction time: bookings/items/orders/invoices copy names, prices, durations and terms. History is never rebuilt from the current catalog.
- Archive, don't delete, historical entities (`archived_at`, `status`).
- Append-only ledgers (DB trigger + revoked privileges) — corrections are new offsetting rows.
- Optimistic concurrency: `version` columns; stale writes → 409 `version_conflict`.
- JSON (`jsonb`) only for defined design/metadata documents (brand tokens, block trees, snapshots, AI output), never as a replacement for relational invariants.

## 7. Idempotency & concurrency

- Clients send an `Idempotency-Key` header for financial, booking and sensitive create operations; `useApiMutation` keeps the key stable across retries of one submission.
- `idempotent(trx, {scope, operation, key, hash}, fn)` stores the result in the same transaction as the operation; concurrent duplicates wait on the unique index and replay; same key + different payload → 422.
- Booking allocations: exclusion constraints; multiple locks acquired in a stable order; whole operation rolls back on any failure.
- Stock: `CHECK (reserved <= on_hand AND on_hand >= 0)` + single `UPDATE … WHERE` statements; movements unique per business event.

## 8. Background work

`src/server/jobs/registry.ts`: domains call `registerJob(kind, handler)`, `registerOutbox(topic, handler)`, `registerPeriodic({name, everySec, run})`, and add one import line to `src/server/jobs/index.ts`. The worker (`pnpm worker`) runs due jobs with exponential backoff, delivers the transactional outbox at-least-once (handlers must be idempotent), and runs sweepers (hold expiry, order expiry, cleanup).

## 9. Storefront vs LUMA identity

- LUMA's identity (brand guide palette, Cinzel/EB Garamond/IBM Plex Sans Arabic, shield logo) is used only on LUMA surfaces via `luma-*` Tailwind tokens.
- A storefront uses `sf-*` tokens bound to CSS variables filled from that business's `brand_settings`. New businesses start neutral.
- `brand_settings` (theme tokens) → `site_drafts.layout` (navigation/header/footer) → `page_drafts.blocks` (block trees). Publishing snapshots all three into an immutable `site_versions` row and moves `tenants.published_version_id` atomically.
- Blocks are configuration validated by the registry in `src/shared/builder/blocks.ts` (schemas, nesting rules, limits, safe actions, migrations). No user/AI HTML or JS is ever executed; URLs are protocol-allowlisted. Catalog references are IDs; prices are always read live from the catalog.

## 10. i18n & UI

- Arabic (RTL) is primary; English mirrors it. Dictionaries live in `src/i18n/messages/<domain>.ts` exporting `{ ar, en }` with identical keys (enforced by `tests/unit/i18n.test.ts`) and are registered in `src/i18n/index.ts`.
- Error messages are translated by stable error code (`errors.<code>`).
- Use logical CSS properties (`ms-/me-/ps-/pe-/start-/end-`) so layouts flip correctly.
- Every screen has loading, empty, error, success and permission-denied states (`src/ui/components/feedback.tsx`). Forms keep input after failures, disable resubmission while pending, show an error summary, label every control, and warn before leaving unsaved drafts.
- Icons: `lucide-react` SVG icons only (no emoji UI icons). Dragging is never the only way to do something (move up/down buttons, keyboard).
- Money via `formatMoney(minor)`, times via `formatDateTime(v, {tz, timeFormat})`; always show the timezone context.

## 11. External integrations (status is always honest)

| Integration | State in this delivery | Notes |
|---|---|---|
| Email / SMS / WhatsApp | Disconnected (dev outbox simulation when `DEV_OTP_ECHO=true`, never in production) | Implement `MessageProvider` in `src/server/infra/messaging.ts`. |
| AI | Disconnected unless `OPENAI_API_KEY` **and** `OPENAI_MODEL` are set | `src/server/infra/ai/`. "Connected" is shown as verified only after a real successful call. |
| Payments | LUMA Sandbox provider (simulated, signed webhooks) | Real providers (Moyasar/Tap/Tabby/Tamara) not integrated; methods appear only when verified & enabled per account. |
| Object storage | Local filesystem driver | S3-compatible driver implements the same `Storage` interface. |

## 12. How to add things

- **Migration**: new file `db/migrations/NNNN_name.sql`; end with `select app.apply_conventions('{{APP_ROLE}}');` (+ `app.make_append_only(...)` for ledgers); run `pnpm db:migrate`; regenerate types with `./scripts/gen-db-types.sh`.
- **Endpoint**: `src/app/api/v1/.../route.ts` using `route({...})`; logic in `src/server/domains/<name>/`; shared zod schema in `src/shared/schemas/`.
- **Job**: `registerJob` in `src/server/domains/<name>/jobs.ts` + one import in `src/server/jobs/index.ts`.
- **Strings**: add to the domain's messages file (both languages).
- **Tests**: `tests/integration/<domain>.test.ts` using `tests/helpers/factory.ts` (`signup`, `createBusinessFor`) and `TestClient` (calls route handlers in-process with cookies and CSRF headers). Tests run against the database in `TEST_DATABASE_URL` (default `luma_test`), which global setup migrates and truncates (it refuses databases not ending in `_test`).

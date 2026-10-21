# LUMA — Progress log & decisions

This file is the hand-off record between work sessions: what exists, what was decided and why, blockers, and next steps. Keep it current.

## Repository state at start (2026-10-21)

- The repository `8malearn123/luma3` was **empty** (no commits, no branches). There was no existing HTML/localStorage prototype, no `LumaStore`/`LumaEvents`/`luma_role`, and no JSON-document workspace to migrate. Everything is built new.
- The only provided asset is the **LUMA brand guide** (PDF): palette `#E4B5CA #CF97BA #9E6898 #5B3764`, blush background, fonts IBM Plex Sans Arabic / Cinzel / EB Garamond, shield logo with the Arabic "لوما" mark and the tagline "Your Beauty, Our Expertise.". The logo was extracted from the PDF as **vector** paths (`public/brand/*.svg`) — not redrawn.

## Key decisions

| Area | Decision | Why |
|---|---|---|
| Stack | Next.js 16 (App Router) + React 19 + TypeScript 5.9, PostgreSQL 16, Kysely, Zod 4, Tailwind 4, TanStack Query | Spec's suggested stack; versions pinned to mature releases (not the newest-day releases). |
| Package manager | pnpm (npm 10 crashed resolving vitest's optional browser peer) | Reproducible lockfile. |
| Auth | Own session auth (opaque cookie token, HMAC-hashed in DB), scrypt passwords, OTP via messaging adapter | Supabase not available in this environment; keeps the DB portable. |
| Tenant isolation | App-level scope **plus** PostgreSQL RLS on every `tenant_id` table, composite `(tenant_id, id)` FKs, runtime role ≠ owner | Defence in depth: a forgotten `WHERE` cannot leak another tenant. Verified by tests. |
| Cross-tenant reads | Only through reviewed `SECURITY DEFINER` functions in schema `app` (slug resolution, own memberships, customer's own bookings/orders, asset serving, platform decisions → actions only) | Allowlisted columns; no blanket bypass. |
| Double booking | `EXCLUDE USING gist` on `booking_allocations` per staff and per resource; holds are allocations with `expires_at`, expired holds released in the same transaction before allocating | DB is the final authority; no SELECT-then-INSERT race. |
| Resources | Each resource is a single unit (3 chairs = 3 resources) | Keeps exclusion constraints exact. |
| Money | `bigint` minor units (halalas); inventory quantities `numeric(14,3)` | No float arithmetic. |
| Ledgers | Append-only (trigger + revoked UPDATE/DELETE): audit_logs, booking_events, stock_movements, financial_entries (balanced double entry, deferred constraint), points, gift card entries, commissions, invoices, site_versions, plan_versions, ai_runs | Corrections are offsetting entries. |
| Roles | Capabilities defined in code (`src/server/auth/capabilities.ts`) with per-role delegable allowlists; memberships store granted/revoked capabilities | Testable, versioned with the code; cannot escalate to platform or ownership powers. The spec's `roles/permissions/role_permissions` tables are replaced by this code registry (documented in [PERMISSIONS.md](PERMISSIONS.md)). |
| Storefront identity | Theme tokens stored once in `brand_settings`; layout in `site_drafts`; blocks in `page_drafts`; publish writes an immutable `site_versions` snapshot. New businesses start from a **neutral** palette, not LUMA purple. | Single source of truth; no duplicated colours. |
| Prices/limits | Plan prices are `NULL` ("pricing not configured"); limits are labelled test values, editable by the LUMA owner | Not approved final values. |
| Messaging | No email/SMS/WhatsApp provider connected. Dev mode (`DEV_OTP_ECHO`) writes to a labelled dev outbox and shows the code on screen; with no provider and no dev echo, registration returns 503 instead of pretending | "Do not pretend an OTP was sent." |
| AI | OpenAI Responses API adapter with strict JSON schema; no key/model in this environment → honest `disconnected`; model id must be configured explicitly | No invented model names; manual flows never depend on AI. |
| Middleware | Next 16 renamed `middleware.ts` → `proxy.ts` (verified in bundled docs) | |

## Status

See [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md) for the requirement-by-requirement table (kept at the end of the delivery).

### Done (with tests)
- Schema: identity, tenancy, catalog, staff/schedules, bookings/allocations, commerce, payments, finance, loyalty/gifts/memberships, builder, policy, marketing/AI/analytics, infra.
- Auth: register/verify/login/logout/sessions/recovery/step-up, lockout, rate limits, CSRF guard, demo switcher hard-disabled in production.
- Tenancy: business creation transaction, memberships, invitations, capability model, support grants, plan entitlements & limits.
- Onboarding: seven steps (save/resume/conflict), deterministic draft generator, readiness checklist, palette suggestions.
- Catalog, team, schedules, leave, attendance, image uploads.
- Infra: audit, idempotency, outbox, jobs runner, notifications, AI adapter.
- UI foundation: i18n (ar/en, RTL), design system, dashboard shell, auth pages, onboarding wizard, landing & pricing.

### Blockers
- **Git push is blocked**: GitHub returns 403 for `8malearn123/luma3` ("Claude doesn't have GitHub access … An org admin can install the Claude GitHub App"). Work is committed locally on `claude/luma-platform-implementation-valfr2`.
- No live messaging, payment, or AI credentials were provided; integrations are adapters + sandbox/dev simulation with honest status.

### Next steps
See the end of this file (updated per session).

## Further design decisions (found in the integrated code)

| Area | Decision | Where |
|---|---|---|
| Holds | A hold is a `booking_allocations` row in state `held` with `expires_at`. Expired holds are released lazily in the allocating transaction and by a 30 s sweeper. | `booking/service.ts`, `booking/jobs.ts` |
| Deadlocks | Allocations are always inserted sorted by staff/resource id, then start time (hold, reschedule, late-payment reallocation). | `booking/service.ts` |
| Rescheduling | Same booking, new item revision. The old allocations are released in the same transaction, so a failure leaves the original untouched. A price change needs explicit acceptance (`acceptTotalMinor`). | `reschedule()`, 0016 |
| Policy snapshot | Cancellation fees, no-show grace and tax rule are read from `bookings.policy_snapshot`, never from the current settings. | `policySnapshot()`, `cancellationRefund()` |
| Payment terms | One algorithm for bookings and orders. Strictest active decision across tenant and platform scope; `manual_approval` is additive; `require_deposit` can only be strengthened. The browser cannot re-enable an option. | `policy/payment-terms.ts` |
| Proof of payment | Only verified webhooks or reconciliation confirm a payment; the redirect never does. A late capture re-allocates the same time if it is still free, otherwise it refunds automatically. | `payments/service.ts` |
| Revenue recognition | Prepayments are `customer_deposits` (liability) until completion; retained cancellation money is recognised on close; order revenue is recognised at payment. | `finance/postings.ts`, `payments/service.ts` |
| Cross-domain effects | Hooks are registered once per process in `src/server/boot.ts` and run inside the originating transaction; each handler is exactly-once by its own unique constraint. | `boot.ts`, `booking/hooks.ts` |
| Background work | Postgres tables only (`job_runs` with `SKIP LOCKED`, `outbox_events` at-least-once); periodic tasks run in the worker process. | `jobs/runner.ts` |
| AI budget | One unit of `limit.ai_runs_monthly` is consumed atomically per Loom job in `usage_counters`; when it is exhausted, Loom falls back to rules. | `marketing/pipeline.ts` |
| Analytics conversions | Conversions are server-side events linked to the storefront session through `analytics_session_id`; browsers cannot claim them. | `analytics/events.ts`, 0022 |
| Migration numbering | Foundation `0001–0024`, then workstream blocks `0100–0500`, applied in lexical order. `apply_conventions()` re-applies append-only revocations (0023). | `db/migrations/` |

## 2026-10-21: repository documentation

- Wrote `README.md` and the `docs/` set: `DATA_MODEL.md`, `PERMISSIONS.md`, `BOOKING_ENGINE.md`, `PAYMENT_FLOW.md`, `BUILDER_SCHEMA.md`, `AI_AND_MARKETING.md`, `TEST_PLAN.md`, `RUNBOOK.md` and `IMPLEMENTATION_STATUS.md`, all from the code on the integrated branch.
- Observed on a scratch database (`luma_d_test`): **Vitest 27/27 files, 193/193 tests passed**; `pnpm typecheck` passed. Playwright was not run by the documentation worker; its last result is recorded by the main engineer.
- Fixed doc references: `ARCHITECTURE.md` now links `docs/PERMISSIONS.md`.
- Gaps and inconsistencies found while documenting are listed in `IMPLEMENTATION_STATUS.md` (no code was changed).

### Next steps
1. Merge the parallel dashboard UIs (bookings, services/team, finance/engagement, staff portal, account booking detail, account waitlist offer) and update `IMPLEMENTATION_STATUS.md`.
2. Close the server gaps listed there, in particular: conversion events on approval and late reallocation; enforcing `builder_components`; production gate for the sandbox provider and a payer check on the simulation endpoints; assistant AI budget; order invoices, credit notes and COGS postings; online purchase of gift cards, memberships and group seats; stuck-job reclamation; mandatory admin MFA.
3. Connect real providers once credentials and approvals exist (payments, messaging, AI). Each needs an adapter and review.
4. Resolve the GitHub App permission (403) so the branch can be pushed.

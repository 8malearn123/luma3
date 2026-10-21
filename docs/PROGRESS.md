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
| Roles | Capabilities defined in code (`src/server/auth/capabilities.ts`) with per-role delegable allowlists; memberships store granted/revoked capabilities | Testable, versioned with the code; cannot escalate to platform or ownership powers. The spec's `roles/permissions/role_permissions` tables are replaced by this code registry (documented in PERMISSIONS.md). |
| Storefront identity | Theme tokens stored once in `brand_settings`; layout in `site_drafts`; blocks in `page_drafts`; publish writes an immutable `site_versions` snapshot. New businesses start from a **neutral** palette, not LUMA purple. | Single source of truth; no duplicated colours. |
| Prices/limits | Plan prices are `NULL` ("pricing not configured"); limits are labelled test values, editable by the LUMA owner | Not approved final values. |
| Messaging | No email/SMS/WhatsApp provider connected. Dev mode (`DEV_OTP_ECHO`) writes to a labelled dev outbox and shows the code on screen; with no provider and no dev echo, registration returns 503 instead of pretending | "Do not pretend an OTP was sent." |
| AI | OpenAI Responses API adapter with strict JSON schema; no key/model in this environment → honest `disconnected`; model id must be configured explicitly | No invented model names; manual flows never depend on AI. |
| Middleware | Next 16 renamed `middleware.ts` → `proxy.ts` (verified in bundled docs) | |

## Status

See `IMPLEMENTATION_STATUS.md` for the requirement-by-requirement table (kept at the end of the delivery).

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

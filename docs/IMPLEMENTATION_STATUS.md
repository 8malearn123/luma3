# Implementation status

As of 2026-10-21, on the integrated branch. Status values:

- **Done**: implemented server-side and covered by tests; any UI that exists is listed.
- **Partial**: implemented with listed gaps.
- **Not started**.
- **Blocked (external)**: needs credentials, contracts or permissions that were not provided.

Test results (latest integrated run): **Vitest 32 files / 212 tests pass**, `tsc` passes, ESLint reports 0 errors, `next build` succeeds, and **Playwright 28/28 journeys pass** against a production build (see [TEST_PLAN.md](TEST_PLAN.md)).

> All dashboard UIs are merged: bookings (list, calendar, detail drawer, walk-in booking), services/catalog, team/HR, settings → payments, finance, waitlist, group sessions, loyalty, gift cards, memberships, the staff portal (`/app/{slug}/me`), `/account/bookings/{id}` and `/account/waitlist/offers/{id}`.

## Status by area

| Area | Status | Evidence | Known gaps |
|---|---|---|---|
| Onboarding | Done | `domains/onboarding/service.ts`, `shared/onboarding.ts` (7 steps), `builder/generator.ts`; pages `/onboarding`, `/app/{slug}/onboarding`; tenancy › "saves, resumes from another session, detects conflicts, and generates a draft without inventing data" | — |
| Builder and publishing | Done | `shared/builder/*`, `domains/builder/*`, migrations 0007 and 0100; page `/app/{slug}/builder`; builder (11 non-assistant tests) | Platform `builder_components` switches and `min_plan_feature` are never applied; custom domains (`domain_mappings`) are not implemented; rollback re-runs structural validation only (no reference checks or readiness); no block type has a schema migration yet |
| AI customization assistant | Partial | `domains/builder/assistant.ts`, `shared/builder/assistant.ts`; builder › 3 assistant tests (fake provider) | **AI provider not connected (Blocked, external)**; assistant calls do not consume `limit.ai_runs_monthly` |
| Catalog | Done | `domains/catalog/service.ts`, 0003; tenancy and booking tests; `limit.services` enforced | No package editing endpoint (create/archive only); variants and add-ons are deactivated, not deleted |
| Team / HR (staff, schedules, leave, attendance, invitations) | Done | `domains/team`, `domains/schedule`, attendance and leave routes; tenancy › invitation; analytics › occupancy | Staff cannot cancel their own leave request; delegated managers can only hand out capabilities they hold; leave approval records `affected_booking_ids`, but there is no reassignment workflow |
| Availability and booking | Done | `booking/engine.ts`, `loader.ts`, `service.ts`; exclusion constraints in 0004; unit/booking-engine (14), booking (12); storefront booking flow `/s/{slug}/booking` | Search limited to 14 days per request |
| Booking lifecycle | Done | `booking/transitions.ts`, `transition()`, `reschedule()`; booking › lifecycle tests | Reschedule drops the variant suffix in the item name snapshot; no reschedule cut-off policy |
| Payments and deposits | Partial | `policy/payment-terms.ts`, `payments/service.ts`, sandbox provider; payment-terms (12), payments (8), commerce-payments (3) | **Only the LUMA Sandbox works; real providers Blocked (external)** ; the sandbox cannot be connected in production and its simulation pages are payer/staff-only |
| Customer account, incidents, policy, appeals | Done | `domains/customers/*`, `domains/policy/*`, 0008 and 0300; `/account/*` pages, `/app/{slug}/policies`, `/platform/policies`; customers (7), policy (14) | No ownership-transfer flow for businesses |
| Products, carts, orders | Partial | `domains/commerce/{products,cart,orders,coupons}.ts`, 0200; `/app/{slug}/products`, `/orders`, storefront cart and checkout; commerce-orders (12), commerce-payments (3) | Approving a return does not refund automatically (refunds are a separate staff action); loyalty points are not earned on orders, although the loyalty comment says so; no order invoice is issued |
| Inventory | Done | `commerce/inventory.ts`, `stock.ts`; `/app/{slug}/inventory`; commerce-inventory (7) | Material consumption and sales are not posted to the journal (`cogs`, `inventory`, `material_costs` are never used); costs come from stock movements in reports |
| Finance, invoices, exports | Partial | `domains/finance/*`, 0005 and 0020; finance (2), payments, booking ("complete posts revenue once") | No order invoices; no credit notes (the kind exists); no COGS postings; `payouts`, `provider_fees` and `owner_equity` unused; refunds after a payroll month is closed do not claw back commission already paid |
| Loyalty | Partial | `domains/loyalty/service.ts`, 0006 and 0019; engagement › loyalty | Earning only on completed paid bookings (not orders) |
| Gift cards | Partial | `domains/giftcards/service.ts`; engagement › gift cards; storefront checkout redemption | Staff issuance at the counter only; **no online purchase**; `paymentTargets.giftCard` not wired |
| Memberships / prepaid packages | Partial | `domains/memberships/service.ts`; engagement › memberships; storefront checkout "apply membership" | Counter sale only; **no online purchase** (public plan list exists); `paymentTargets.membership` not wired; no-show releases the reservation (comment says "consumes per policy") |
| Waitlist | Done | `domains/waitlist/service.ts`, 0018; storefront join in `BookingFlow`; waitlist-groups › waitlist | — |
| Group sessions | Partial | `domains/groups/service.ts`; waitlist-groups › group sessions | On-site payment only (no online checkout for seats); session cancellation cancels seat bookings in separate transactions; storefront `/s/{slug}/groups` is not linked from the storefront navigation |
| Payroll | Done | `domains/payroll/*`, migration 0600; `/app/{slug}/payroll` (sheet, entries, base salaries and employment dates, commission per category with tiers), seller on orders, «أرباحي» card in the staff portal, tip button on the booking drawer; payroll (3), unit payroll (3), capabilities (1). See [PAYROLL.md](PAYROLL.md) | No per-staff commission overrides; a refund after a month is closed does not reduce commission already paid |
| Analytics and employee performance | Done | `domains/analytics/*`, 0009 and 0400; `/app/{slug}/analytics`; analytics (6) | Conversions count storefront-sourced bookings on every confirm path (payment, approval, late reallocation) |
| Loom core (phases 1–2) | Done (rules path) | `src/loom/*`, migration 0700, `/api/v1/t/{slug}/loom/*`, `/platform/loom`, marketing tabs «الفرص» and «إعداد لووم»; loom-* unit (7 files) and integration (3 files) tests. See [LOOM_CORE.md](LOOM_CORE.md) | LLM planner, plan_actions tables, radar/official calendars, outcome memory, learned models (phases 3–7); recommendations still come from `marketing/rules.ts` |
| Loom Marketing, trends, campaigns | Partial | `domains/marketing/*`; `/app/{slug}/marketing`; marketing-ai (11), trends (4), campaigns (5) | **AI not connected (Blocked, external)**: rules-based plans only in this environment; trend assessment is rules-only by design in current code; **email/SMS/WhatsApp sending Blocked (external)**, so campaigns can only simulate (dev) or use in-app |
| Notifications | Partial | `infra/notify.ts`, `infra/messaging.ts`, `domains/notifications/jobs.ts`; notifications (1) | In-app works; **email/SMS/WhatsApp providers not connected (Blocked, external)**: dev outbox only, `none` in production |
| Platform admin and subscriptions | Done | `domains/platform/*`, `domains/subscriptions/*`, 0500; `/platform/*` pages; platform (12), subscriptions (6), settings-support (5) | Subscription billing is **test-only** (DB CHECK `is_test`; invoices marked paid manually; no real charging); platform staff must enrol in MFA (always in production, `PLATFORM_MFA_REQUIRED`) |
| Platform admin phase 2 (prices, founding, promotions, analytics, reports, activity, settlements, referrals, settings, live feed) | Done | migration 0630; `domains/platform/{pricing,settings,insights,activity,export}.ts`, `domains/referrals`, `domains/settlements`; `/platform/{analytics,activity,feed,settlements,referrals,settings}`, `/app/{slug}/referrals`, `/pricing`; admin-pricing (4), admin-ops (8), admin-referrals (2). See [PLATFORM_ADMIN.md](PLATFORM_ADMIN.md) | Marketplace fees read through an adapter until the marketplace branch is merged; no real billing/payout provider (manual references) |
| Security | Partial | RLS on 124 tables, composite FKs, 18 reviewed definer functions, CSRF, rate limits, lockout, step-up, MFA, SSRF-safe fetch, CSP; tenancy, auth, platform, trends tests | No automatic reclaim of stuck `running` jobs; periodic tasks duplicate across workers; HSTS left to the proxy; no step-up for invitations or owner plan changes |
| Plans | Done | `shared/plans.ts`, 0012, 0630 (approved prices), `tenancy/access.ts`; subscriptions › plan limits; builder › pages and plan policy; admin-pricing | Feature limits are still test values; the AI usage report and the enforced AI budget count different things |
| Seed | Done | `scripts/seed.ts`; used by E2E global setup | Credentials only in the gitignored `.demo-credentials.txt`; seeds products, reviews from verified visits, an incident under review, an appeal, an example marketing plan, and publishes both storefronts |
| Tests | Done | Vitest: 32 files, 212 tests, all passing; Playwright: 4 specs, 28 journeys, all passing | See [TEST_PLAN.md](TEST_PLAN.md#not-covered-by-automated-tests) |

## Phase 2 (November 2026)

Built from the comparison with the old static LUMA and the decisions in [DECISIONS_2026-11.md](DECISIONS_2026-11.md). Merged test run: Vitest 67 files / 336 of 337 tests pass (the remaining failure is the invoice PDF test, which needs a Chromium that matches playwright-core; it fails the same way before phase 2). `tsc` and ESLint (0 errors) pass, and `next build` succeeds.

| Area | Status | Docs | Known gaps |
|---|---|---|---|
| HR: leave balances, approval chains and request types, lateness/absence suggestions, booking reroute, owner-only staff file, per-staff commission | Done | [HR.md](HR.md) | Letter requests end at approval (no generated letter); partial-day leave counts whole days; approved leave cannot be cancelled through the chain |
| سوق لوما: `/discover`, listing by request, verification, favourites/explore, marketplace commission per business | Done | [MARKETPLACE.md](MARKETPLACE.md) | A refund after completion does not reverse the commission line; commission is in its own ledger, not the business journal |
| Platform admin: prices/yearly/founding/promotions, analytics, activity, settlements, referrals, reports, settings/maintenance, live feed | Done | [PLATFORM_ADMIN.md](PLATFORM_ADMIN.md) | No real billing/payout provider (manual references); marketers have no own login |
| Customer experience: booking branch + coupon scope, rebook, loyalty in account, review requests, online gift cards/memberships, acquisition source, 404, remember me, back arrow | Done | [CUSTOMER_EXPERIENCE.md](CUSTOMER_EXPERIENCE.md) | Orders do not record acquisition yet; coupons are not applied to dashboard bookings |
| Business dashboard: overview (salon/expert), ZATCA phase-1 QR, store QR, branch switcher, low-stock alerts, crop editor, service badges, weekly digest | Done | [BUSINESS_DASHBOARD.md](BUSINESS_DASHBOARD.md) | Branch restriction applies to lists, not single-record reads; journal figures are not split by branch |
| Expert: expert workspace labels, event bookings with deposit, before/after portfolio, Instagram block | Done | [EXPERT.md](EXPERT.md) | Instagram connect needs Meta credentials; event messages are in-app only |

## External blockers

| Blocker | Effect |
|---|---|
| **Real payment providers need credentials and approval** (Moyasar, Tap, Tabby, Tamara) | Only the LUMA Sandbox simulation is integrated. Methods appear only when an account is verified and enabled, so customers never see real card, mada, Apple Pay or BNPL options. |
| **Real SMS / email / WhatsApp providers are not connected** | `EMAIL_PROVIDER` / `SMS_PROVIDER` / `WHATSAPP_PROVIDER` accept only `none`. Development uses the labelled dev outbox (`DEV_OTP_ECHO`). In production, registration codes return 503 instead of pretending, and campaigns on those channels cannot start. |
| **The AI provider is not connected** | No `OPENAI_API_KEY` / `OPENAI_MODEL` in this environment. AI features report `disconnected`; Loom produces rules-based output; the assistant returns 503. |

## Fixed during integration (security and correctness)

| Issue | Fix |
|---|---|
| Specialists received booking money fields | Stripped server-side for assigned-only staff |
| Open redirect via `/\host` in `next` | `shared/safe-path.ts` used for every post-login/MFA redirect |
| A delegated manager could create users with powers she lacks (e.g. finance) | `capabilitiesBeyondActor` check on invite and role change |
| Rescheduling kept a membership discount for a different service | Reservations follow only same-service items still covered; otherwise released |
| Rate limits trusted spoofable `X-Forwarded-For` entries | Client IP is the proxy-appended hop (`TRUSTED_PROXY_HOPS`) |
| Platform admins could skip MFA | Enrolment enforced (always in production) |
| Unsubscribe links and campaign sends hashed suppressions differently | One keyed hash; every simulated message carries a signed unsubscribe link |
| Append-only ledgers regained UPDATE/DELETE grants on each migration | `apply_conventions` re-applies revocations (0023) |
| Paused subscriptions were writable | Paused workspaces are read-only |
| Platform reviewers could not view escalated evidence; no retention purge | Escalated-only access with MFA (0024); periodic purge past `retain_until` |
| Variant/add-on PATCH returned 500; staff PATCH reset hidden profiles to public | Dedicated patch schemas |

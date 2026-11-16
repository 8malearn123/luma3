# LUMA Audit Report

| | |
|---|---|
| Revision audited | `6455e2c61eef363f171991f1acc58b2deedd8b42` (branch `claude/clever-ptolemy-cxzufg`, PR 8malearn123/luma3#11) |
| Audit window | 2026-11-16 09:24 – 10:27 UTC |
| Environment | Cloud Linux container; Node 22.23.4; PostgreSQL 16 (local); production build (`next build` + `next start`) per journey set; headless Chromium (Playwright); sandbox payment provider; no external credentials |
| Product code changed during audit | **None.** Journeys ran in two detached worktrees (`audit-a`, `audit-b`) against dedicated databases (`luma_audita_e2e`, `luma_auditb_e2e`); both worktrees end with a clean `git status`. Only this report was added to the repository. |
| Evidence location | Screenshots, accessibility snapshots, logs and archived temporary specs are in the audit container under `/tmp/claude-0/-home-user/2d934d0a-919e-5fd4-a0e7-41a8257a7422/scratchpad/audit/` (`a/` = journeys 1/3/4 — 118 shots; `b/` = journeys 2/5/6/7/8 — 88 shots). They are not committed; file names are cited per finding. |

Finding IDs are `LUMA-AUDIT-001…049`. Severity: **P0** critical security/data-integrity failure · **P1** core journey blocked or materially incorrect · **P2** significant degradation with workaround · **P3** minor.

---

## 1. Executive verdict

| Stage | Verdict | Basis |
|---|---|---|
| **Internal demonstration** | **CONDITIONALLY READY** | Customer booking (incl. mid-flow login, deposit, reschedule, cancel), product purchase with last-unit protection, builder draft/publish/version restore, inventory receipt→transfer→issue with frozen costs, workspace booking→payment→check-in→settlement, Loom rules-based plans, and role/tenant isolation were all **observed working in a browser** on seeded data with the sandbox provider. Conditions: (a) storefront brand colours/fonts do not render (LUMA-AUDIT-003) — visible in any demo; (b) salons cannot create/edit a workspace listing in the UI (LUMA-AUDIT-004 — page crash); (c) staff invitations cannot be accepted (LUMA-AUDIT-005); (d) demo must connect the sandbox payment provider first (LUMA-AUDIT-006); (e) the job worker must run or analyses/holds never progress (LUMA-AUDIT-043). |
| **Limited user pilot** (real businesses/customers) | **NOT READY** | No message-delivery provider exists, so production registration returns 503 and recovery/invites/OTP cannot be delivered (LUMA-AUDIT-007). A "review" deployment — the only mode that can run without a provider — echoes password-reset and platform-MFA codes to anyone (LUMA-AUDIT-001), so it must not hold real users. Platform policy actions skip MFA (LUMA-AUDIT-002). No live payment provider (LUMA-AUDIT-008). Invites broken (LUMA-AUDIT-005). |
| **Commercial launch** | **NOT READY** | All pilot blockers, plus: subscription billing is manual test invoices and plan upgrades apply without payment (LUMA-AUDIT-008/025); ZATCA phase 2 not implemented; finance is operational reporting, not accounting (and omits hosting revenue/expense, LUMA-AUDIT-010); unresolved commercial decisions (freelancer plans, LUMA Plus, plan matrix, custom domains — §9). |

Baseline checks on the audited revision: `pnpm typecheck` exit 0; `pnpm lint` 0 errors / 11 warnings; `pnpm test` **564 passed, 1 failed of 565** (99 files). The failure is `tests/integration/finance.test.ts` "reports deposits as liabilities…" — the invoice PDF route returns **503** locally (headless-Chromium/PDF renderer version mismatch in this container); it passes in GitHub CI on this revision (all 4 CI checks green). A build passing is **not** used as evidence for any journey below.

---

## 2. Audit scope and limitations

**Accessed:** full repository (src, db/migrations 0001–0810, scripts, tests, docs incl. README, ARCHITECTURE, IMPLEMENTATION_STATUS, PROGRESS, DECISIONS_2026-11, HOSTING_INVENTORY_DECISIONS, BUILDER_SCHEMA, MARKETPLACE, EXPERT, CUSTOMER_EXPERIENCE, PAYMENT_FLOW, BOOKING_ENGINE, LOOM_* , PERMISSIONS, PLATFORM_ADMIN, DESIGN_GUIDE), the older static prototype `/home/user/luma` (reference only), local Postgres (read-only SELECTs on `luma_test`; seeded audit DBs).

**Ran:** typecheck, lint, full vitest suite; two production builds; 8 browser journeys (≈40 temporary Playwright specs, archived in the evidence folder); failure-case scenarios listed in §5; direct API probes for isolation; DB queries to verify persistence (journal entries, stock movements, booking states).

**Unavailable / not tested:**
- Real external providers (payments Moyasar/Tap/Tabby/Tamara, email/SMS/WhatsApp, OpenAI, Instagram, ZATCA Fatoora, Loom radar APIs) — **no credentials**; only sandbox/fallback behaviour verified.
- Real Vercel/Neon deployment — not deployed; review-build behaviour (LUMA-AUDIT-001) verified in code (`src/server/hosting/vercel.ts:45-56`, `auth/dev-outbox/route.ts`), not on a live URL.
- Platform-admin MFA journey was exercised only in Journey 7 (MFA page + `/platform/loom`); other platform-admin screens were not walked.
- AI timeout path: inspected in code only. Booking-with-recipe consumption in the browser: covered by integration tests (`hosting-inventory-cycle.test.ts`), the browser journey used manual issue instead.
- Inventory UI for a Sanaa-plan business (plan-gated) — Journey 4 could not inspect stock in `/inventory` for the new Sanaa salon; verified via product list and public page instead.

**Test-environment changes (recorded):** created audit accounts/businesses (`audit-*@audit.test`, `audit-salon-*`), test listings/bookings/orders in the two audit DBs; cleared `rate_limit_buckets` login rows in the audit DBs (login rate limit was hit by test automation); started `scripts/worker.ts` for set B. No changes to `luma_test` beyond the normal test-suite run, none to any shared/production config.

---

## 3. Actual product structure

**Roles** (`src/server/auth/capabilities.ts`): business roles owner, manager, receptionist, specialist, finance, warehouse; synthetic `support` (time-limited support grant); platform roles platform_owner, support_admin, policy_reviewer, technical_admin; customer = any signed-in user (central identity).

**Experiences (105 pages, 541 API handlers):**
- Business dashboard `/app/[tenantSlug]/*` (33 pages; 369 tenant API handlers — loom 47, marketing 38, inventory 30, builder 18, hosting 17, hr 16, policies 15, workspace 14, payroll 14, purchasing 13, finance 10…).
- Freelancer = same dashboard with `business_type='expert'` and a relabelling profile (`src/shared/workspace-profile.ts`) — hides only Groups and Hosting.
- Storefront `/s/[slug]` (23 pages; 36 storefront API handlers): services, booking flow, products/cart/checkout, gift cards, memberships, events, groups, waitlist.
- Discovery `/discover`, `/discover/salons`, `/discover/experts` with `app.marketplace_directory()`.
- Customer account `/account/*` (12 pages): bookings, orders, policy/appeals, privacy, security, reviews.
- Platform admin `/platform/*` (22 pages, 86 handlers) incl. Loom settings, calendar, external businesses, policies, plans.
- Auth (login/register/recover/verify), onboarding wizard, preview tokens, pricing, referral redirects, unsubscribe, sandbox checkout.

**Tenancy model:** shared Postgres with RLS on all 179 tables carrying `tenant_id` (`app.tenant_visible()`), app role `luma_app` (non-superuser), `withTenant` per request, `withSystem(reason)` for jobs/admin/webhooks, cross-tenant hosting tables with explicit host/guest RLS, `loom` schema with its own business isolation. Deployed builds refuse to run as an owner/bypass role (`db/role-guard.ts`).

**Background work:** ~40 periodic tasks plus queued jobs (booking hold expiry, reminders, reconciliation, commerce expiry/abandon/stock balance, loyalty/giftcards/memberships expiry, hosting expiry, finance open bills, subscriptions lifecycle, Loom analysis/planner/radar/measurement/models). Runner = `scripts/worker.ts` or `GET /api/v1/internal/cron` (Bearer `CRON_SECRET`, scheduled by GitHub Actions every 5 min). `vercel.json` defines no crons. The Playwright web server does **not** start the worker.

**Integrations:** see §7. In short: sandbox payments (verified), no messaging adapters, OpenAI adapter without key, local/DB storage, OpenStreetMap links, ZATCA phase-1 QR only, Instagram partial.

---

## 4. Requirements coverage matrix

Status: **Verified** (traced UI→API→DB and/or observed in browser) · **Code-verified** (traced in code, not exercised in browser) · **Partial** · **Missing** · **Decision pending**. "B" = observed in browser during this audit.

| Requirement ID | Capability | Status | Evidence | Gap or blocker |
|---|---|---|---|---|
| **A. Accounts, tenancy, permissions** |||||
| REQ-A01 | Registration + email verification | Verified (B, review mode) | J1 sign-up, dev code on screen; `auth/service.ts` | Production returns 503 (no provider) — 007 |
| REQ-A02 | Login, sessions, CSRF, lockout | Code-verified | session HMAC, rotation, idle/absolute expiry; CSRF header+Origin | Lockout DoS — 027 |
| REQ-A03 | Password recovery | Partial | `requestRecovery` | Review builds echo codes — 001; prod undeliverable — 007 |
| REQ-A04 | Business creation + business-type selection | Verified (B) | `/app/new` (Salon, Independent expert, Beauty center, Spa) | — |
| REQ-A05 | Platform admin vs tenant separation + MFA | Partial | `platformRoute` + `requirePlatformMfa`; J7 403 `mfa_required` | 8 policy routes skip MFA — 002 |
| REQ-A06 | Staff invitations | **Broken** | link `/invite/<token>` 404 (B, J8) | 005 |
| REQ-A07 | Scoped roles (6) server-enforced | Verified (B) | J8 role matrix; API 403/404 | — |
| REQ-A08 | Tenant isolation DB/API/storage/jobs/caches | Verified (B + code) | J8 cross-tenant 404s; RLS on 179 tables; media auth; jobs carry tenant | — |
| REQ-A09 | Subscription limits server-side | Code-verified | `requireWithinLimit` (branches, staff, services, products, locations, spaces, AI) | Lapsed subs still sell on storefront — 012 |
| REQ-A10 | Central customer identity w/o cross-business leakage | Code-verified | `tenant_customers` per business; link only by customer action | — |
| REQ-A11 | Demo switching off in production | Code-verified | forced off when `APP_ENV=production` | Review default exposes codes — 001 |
| **B. Salon & freelancer management** |||||
| REQ-B01 | Services, prices, durations, categories | Verified (B) | J1/J2 service created; storefront shows it | — |
| REQ-B02 | Variants/add-ons in dashboard | Code-verified | `addons`, `variants` routes | — |
| REQ-B03 | Variants/add-ons chosen online by customer | Partial | API accepts `variant_id/addon_ids`; `BookingFlow.tsx:162` never sends | 018 |
| REQ-B04 | Packages/offers editing | Partial | packages GET/POST/DELETE only | 033 |
| REQ-B05 | Staff, specialties, hours, breaks | Verified (B) | J1 schedule saved; J2 hours persisted | Onboarding hours ≠ staff schedule (049) |
| REQ-B06 | Leave & HR | Code-verified | `hr`, `leave` routes (0610) | — |
| REQ-B07 | Bookings dashboard | Verified (B) | J3 owner list shows booking + payment status | — |
| REQ-B08 | CRM | Code-verified | `/customers`, `tenant_customers` | — |
| REQ-B09 | Products & orders | Verified (B) | J4 order Paid in owner list | Pickup only |
| REQ-B10 | Finance records/exports | Partial (B) | Finance page loads; exports tab | Omits hosting revenue/expense — 010 |
| REQ-B11 | Storefront branding & publication | **Partial (B)** | publish works | Brand colours/fonts not rendered — 003 |
| REQ-B12 | Workspace listing management (salon) | **Broken (B)** | "New space"/"Edit" crash | 004; add-ons UI missing — 009 |
| REQ-B13 | Subscription & plan change | Partial | `change-plan` | Test billing; no cycle change; upgrade unpaid — 008/025 |
| REQ-B14 | Team access | Partial | capabilities OK | Invites broken — 005 |
| REQ-B15 | Freelancer profile/services/schedule/clients | Verified (B) | J2 | Own schedule shown "read-only, contact management" — 014 |
| REQ-B16 | Freelancer storefront | Verified (B) | `/s/lamar-makeup` 1440/375, service visible | — |
| REQ-B17 | Freelancer products/inventory | Partial | Sanaa: products on, inventory off | Plan decision (§9) |
| REQ-B18 | Freelancer income/expense incl. hosting | Partial (B) | "Expenses & dues" in workspace page | Finance P&L ignores hosting — 010; per-salon figure mismatch — 037 |
| REQ-B19 | Freelancer workspace discovery/booking | Verified (B) | J2/J6 | No compare view — 048 |
| REQ-B20 | Solo-freelancer simplicity | Partial (B) | menu shows Payroll, Team/HR, Audit, branch limits | 014 |
| **C. Builder & branding** |||||
| REQ-C01 | Logo, colours, fonts, images, info | **Partial (B)** | saved in draft (API) | Not rendered on storefront — 003 |
| REQ-C02 | 7-step onboarding | Verified (B) | 7 steps + generate stage | Opens at step 2; two primary buttons (049) |
| REQ-C03 | Drag-and-drop + keyboard alternatives | Code-verified | dnd-kit keyboard sensor, move up/down, Add buttons | — |
| REQ-C04 | Blocks (services, products, gallery, offers, contact, …) | Verified (B, partial set) | 27 block types; hero/CTA/featured product used | — |
| REQ-C05 | Links to services/products/pages + validation | Verified (B) | CTA→service page worked; tenant ownership validated | — |
| REQ-C06 | Draft save/persistence | Verified (B) | "Last saved"; API draft matches | No auto-retry after reconnect — 040 |
| REQ-C07 | Preview (desktop/mobile) | Verified (B) | canvas toggle + preview pop-up at 1440/375 | Preview link is a 24 h bearer link (note) |
| REQ-C08 | Draft vs published separation | Verified (B) | draft "v2 DRAFT" absent from public HTML | — |
| REQ-C09 | Version restore | Verified (B) | "Copy into draft" restored v1 | Rollback skips reference checks — 031 |
| REQ-C10 | Archived references | Verified (B) | featured product dropped, CTA falls back, 404 pages friendly | Live store with no bookable service — 017 |
| REQ-C11 | Stable unique URL `/s/[slug]` | Code-verified | slug immutable | — |
| REQ-C12 | Custom domain / subdomain | Missing; Decision pending | `domain_mappings` unused; no host routing | 045 |
| REQ-C13 | Platform block on/off switches | Missing | `disabledComponentTypes()` never called | 019 |
| **D. Discovery & transactions** |||||
| REQ-D01 | Browse businesses & freelancers | Verified (B) | `/discover` → salon → storefront | "1 businesses" plural (039) |
| REQ-D02 | Search & filters | Code-verified | `/api/v1/market/search` | — |
| REQ-D03 | Direct booking + attribution | Verified (B) | `?via=luma_market` | — |
| REQ-D04 | Service + specialist selection | Verified (B) | J3 | — |
| REQ-D05 | Availability | Verified (B) | slots shown and reserved | — |
| REQ-D06 | Resource allocation / double booking | Verified (B + DB) | GiST exclusion; J6 race 201/409 | — |
| REQ-D07 | Login without losing selection | Verified (B) | service/specialist/time kept | Session-expiry path dead-ends — 016 |
| REQ-D08 | Confirm/reschedule/cancel/history | Verified (B) | BKG-000110 rescheduled; BKG-000109 cancelled "Refund pending" | — |
| REQ-D09 | Cart/checkout/stock reservation/order tracking | Verified (B) | ORD-000001 Paid; last unit protected | No provider → dead end holding stock — 006 |
| REQ-D10 | Deposit/full payment eligibility | Verified (B) | deposit SAR 70 and full payment both observed | — |
| REQ-D11 | Booking status ≠ payment status | Verified (B) | "Confirmed | Deposit paid", "Cancelled | Refund pending" | Account list shows only booking status (UX) |
| REQ-D12 | Refunds | Partial | refund pending observed | Commission not reversed — 020 |
| REQ-D13 | Webhook validation/idempotency/reconciliation | Verified (sandbox, B + code) | replayed outcome → `ignored`; `onConflict…doNothing` | Rate-limit key spoofable — 026 |
| REQ-D14 | Live payment providers | Missing (blocked) | registry: sandbox only | 008 |
| **E. Inventory & finance** |||||
| REQ-E01 | Main + additional locations | Verified (B) | J5 station location created | — |
| REQ-E02 | Chair stock / custody | Verified (B) | station linked to «كرسي 1» | — |
| REQ-E03 | Receipts vs supplier invoices vs payments | Verified (B receipt; code + integration test for invoice/payment) | RCV-000001; `hosting-inventory-cycle.test.ts` | Posted invoice can't be voided (046) |
| REQ-E04 | Transfers keep total | Verified (B + DB) | main 420 / station 170; transfer_out −200 / transfer_in +200 | — |
| REQ-E05 | Recipes vs actual consumption once | Code-verified + integration test | `material_consumptions`; cycle test asserts exactly one movement | Not browser-exercised |
| REQ-E06 | Sales/returns/waste/counts | Code-verified | movement kinds; counts apply | — |
| REQ-E07 | Unit conversions | Code-verified | `conversion_factor` | Item-card edit API-only |
| REQ-E08 | Historical costs (weighted average) | Verified (B + DB) | frozen unit cost 50 halalas on movements | Seed stock lacks opening movement — 036 |
| REQ-E09 | Finance visibility/permissions | Verified (B) | J8 role matrix | — |
| REQ-E10 | Duplicate stock movements/costs prevented | **Partial (B)** | receipt/transfer idempotent | Manual issue duplicates — 011 |
| REQ-E11 | Accounting vs operational | Operational reporting only | `inventory-journal.ts` header | No period close, credit notes, landed cost |
| **F. Workspace rentals** |||||
| REQ-F01 | Salon-controlled publication | Partial (B) | publish/pause in UI works | Create/edit crash — 004 |
| REQ-F02 | Availability vs internal bookings/linked staff | Code-verified + tests | `resource_staff_links`, exclusion constraints | Events/groups checked in app only (046) |
| REQ-F03 | Fixed price only (D2) | Verified (B) | "SAR 50 / hour" | Unlabelled second amount — 037 |
| REQ-F04 | Equipment/add-ons, no included materials (D5) | Partial (B) | "No materials are included"; add-on booked | Add-on configuration UI missing — 009 |
| REQ-F05 | Terms snapshot; stale terms refused | Verified (B) | 409 `terms_changed` | — |
| REQ-F06 | Search/compare | Partial (B) | list + filters + sorts | No compare — 048 |
| REQ-F07 | Booking hold, approval, expiry | Verified (B + DB) | WSB held→expired with worker | — |
| REQ-F08 | Separate but linked client appointment | Partial (B) | API link works; host can't see client | No UI to link — 013 |
| REQ-F09 | Conflict prevention (space, equipment, freelancer) | Verified (B race) + tests | 201/409; `staff_space_no_overlap` | — |
| REQ-F10 | Charges, settlement, invoice, check-in/out, review | Verified (B + DB) | WSB-000001 settled; INV-000001/2; balanced journals | Figures/VAT split clarity — 037 |
| REQ-F11 | Plan allocation (D12) | Decision pending | matrix «مقترح — غير معتمد» | §9 |
| **G. Loom Marketing** |||||
| REQ-G01 | Monthly & weekly plans | Verified (B) | both prepared (rules) | Two plan systems — 021 |
| REQ-G02 | Opportunities with approve/defer/dismiss/convert | Verified (B) | statuses converted/dismissed/deferred | Convert duplicates initiative — 038 |
| REQ-G03 | Edit + version history | Verified (B) | edit → v4; compare versions | Raw JSON in compare — 024 |
| REQ-G04 | Sourced trends / seasonal events | Partial | radar "No external sources"; starter calendar | Providers disconnected |
| REQ-G05 | Operational evidence + capacity/inventory/margin checks | Verified (B) | computed metrics 82 sales, SAR 16,765.05 | Raw halalas / internal keys — 023/024 |
| REQ-G06 | Recorded outcomes | Verified (B, empty) | Results tab | — |
| REQ-G07 | Real AI output | Missing (blocked) | `ai-status disconnected/no_api_key`; clear "rules-based" labels | Needs key |
| REQ-G08 | No mandatory chatbot | Verified (B) | 0 chat widgets | — |
| REQ-G09 | Analysis status visibility | **Defect (B)** | tab says "No analyses yet" | 022 |
| **H. Additional** |||||
| REQ-H01 | Loyalty | Partial | display-only tiers; no earning on orders | — |
| REQ-H02 | Gift cards | Code-verified | storefront purchase route | Scheduled delivery needs messaging |
| REQ-H03 | Memberships / prepaid packages | Code-verified | storefront purchase route | — |
| REQ-H04 | Waitlist | Code-verified | `BookingFlow.tsx:318` | — |
| REQ-H05 | Group sessions | Partial | on-site payment only; not in storefront nav | 032 |
| REQ-H06 | Reviews only after completed visits | Code-verified | UNIQUE(tenant, booking) | — |
| REQ-H07 | Incidents, appeals, payment-policy decisions | Code-verified | `/account/policy`, `/platform/policies` | Platform policy MFA gap — 002 |
| REQ-H08 | Notifications | Partial | in-app works; email/SMS/WhatsApp to dev outbox | 007 |
| REQ-H09 | Reports & exports | Verified (B, inventory) | 11 inventory reports translated | — |
| REQ-H10 | Dark mode (DESIGN_GUIDE, decided 2026-11-15) | Missing | no dark tokens; body unchanged under dark scheme (B) | 035 |

---

## 5. User-journey results

| Journey | Role | Result | What was actually tested | Evidence (`audit/…`) | Blocker |
|---|---|---|---|---|---|
| 1 New salon owner | New owner + logged-out visitor | **PASS with defects** | Sign-up (double-click → 1 POST), business type, 7-step onboarding (opens at step 2), service, specialist + weekly hours, booking policy, 2 products, builder brand colour/wordmark/hero/CTA→service/featured product, mobile+desktop preview, publish, public check, draft leak test (none), version restore, archive service/product → graceful fallback | `a/shots/j1-04…j1-46`, `j1-30-public-v1-desktop.png`, `j1-33-public-after-draft.png` | Brand colours/fonts not applied (003); no payment provider required (006) |
| 2 Freelancer | Expert (lamar) | **PASS with UX defects** | Dashboard menu review, create service 450 SAR/90 min, Saturday hours to 20:00 (persisted), storefront 1440/375, workspace search, city filter, distance sort needs location, details drawer with price check | `b/j2-expert-home-375.png`, `j2-expert-me.png`, `j2-expert-payroll.png`, `j2-workspace-details.png` | Payroll/HR/branches clutter; "read-only, contact management" on own schedule (014) |
| 3 Customer booking | Customer, owner, specialist | **PASS with UX defects** | Discover→storefront→service→specialist→slot, login mid-flow (selection kept), deposit SAR 70 via sandbox, failed then successful payment, full-payment booking, customer/owner/staff views, staff can't open other staff's booking, reschedule, cancel with refund preview | `a/shots/j3-02…j3-35` | Failed payment silent (015); session-expiry dead end (016) |
| 4 Product purchase | Two customers, owner | **PASS after manual provider setup** | Concurrent checkout of last unit (no oversell), "No payment option" dead end while stock reserved, owner connects sandbox, pay (double-click → 1 POST), order Paid for customer+owner, product "Out", public "Currently unavailable" | `a/shots/j4-A-after-continue.png`, `j4-B-after-continue.png`, `j4-10-paid.png`, `j4-12-owner-orders.png` | 006 |
| 5 Inventory & finance | Owner | **PASS with defects** | Location «محطة كرسي 1» linked to chair, supplier, receipt RCV-000001 (500 ml @ 0.50), transfer TRF-000001 200 ml, manual issue 30 ml, over-issue refused, balances (420/170), valuation = ledger (diff 0), finance material cost; idempotent replay of receipt/transfer; DB movements with frozen cost | `b/j5-receipts.png`, `j5-transfers.png`, `j5-balances.png`, `j5-report-inventory_value___payables.png`, `j5-finance.png` | Manual issue duplicates without key (011); seed lacks opening movements (036). Recipe consumption not browser-tested (integration-tested) |
| 6 Workspace hosting | Owner, expert | **FAIL (blocking UI defect)**; downstream PASS | "New space" → crash; listing created via API, then published in UI; expert books WSB-000001 with add-on, sandbox pay, confirmed + QR + INV-000001, wrong/right check-in code, material request, check-out, settlement approved, dues paid INV-000002, review; second booking + client appointment linked **via API**; host cannot see client (API 404); balanced journals for both parties | `b/j6-new-space-crash-no-units.png`, `j6-ws-booking-confirmed.png`, `j6-host-money.png`, `j6-expert-expenses.png` | 004 crash; 009 add-ons UI; 013 link UI; 010 finance omission |
| 7 Loom Marketing | Owner, platform owner | **PASS with defects** | 11 tabs, analyse now (needs worker), monthly + weekly plan (rules-based, labelled), opportunity evidence, approve/dismiss/defer/convert, edit → v4, compare, approve plan, results, setup checklist, platform Loom settings after MFA | `b/j7-loom-home.png`, `j7-plan-compare.png`, `j7-plan-approved.png`, `j7-platform-loom.png` | Status tab wrong (022); raw halalas (023); raw keys/JSON (024) |
| 8 Roles & isolation | 6 roles + expert + customer + platform | **PASS (except invites)** | Page access per role, direct API probes across tenants and roles (403/404/401), expert/owner cross-slug, platform admin on tenant APIs (404) | `b/j8-invite-link.png`, `j8-specialist-team.png`, `j8-warehouse-inventory.png` | Invite link 404 (005) |

**Failure cases**

| Scenario | Executed / Inspected / Not tested | Result |
|---|---|---|
| Duplicate submission (register, product save, booking confirm, order pay) | Executed | PASS — 1 request each |
| Duplicate stock operations (receipt, transfer, space booking with same Idempotency-Key) | Executed | PASS — same document returned; reused key with different body → 422 |
| Manual stock issue submitted twice | Executed | **FAIL** — both accepted (011) |
| Concurrent booking of same space | Executed | PASS — 201 / 409 `slot_unavailable` |
| Concurrent purchase of last stock unit | Executed | PASS — second buyer blocked |
| Session expiry mid-booking | Executed | **FAIL (UX)** — dead end (016) |
| Network failure during form submit | Executed | PASS — input kept, retry saved once |
| Network failure during builder autosave | Executed | PARTIAL — edit kept, no auto-retry (040) |
| Invalid / unauthorized IDs, cross-tenant | Executed | PASS — 404/403/401 |
| Expired holds (space + client appointment) | Executed (worker running) | PASS — `expired` |
| Archived service/product references | Executed | PASS — graceful fallback |
| Draft leaking into published storefront | Executed | PASS — no leak |
| Payment failure (sandbox) | Executed | Functional PASS; **no message** (015) |
| Duplicate payment outcome / webhook | Executed (outcome replay) + inspected (event-id dedupe) | PASS |
| Missing AI credentials | Executed | PASS — rules fallback, clearly labelled |
| AI timeout / provider failure | Inspected in code (`src/loom/planner/run.ts` catch → `ai_failed` → rules) | Not executed |
| Stale workspace terms / outside window / closed day | Executed | PASS — 409/422 |
| Login brute force | Observed | 429 after limit (see also 027) |

---

## 6. Prioritized findings

Format: **ID — Title** · Type · Severity · Role/module · Requirement reference.

### P1

**LUMA-AUDIT-001 — Review builds let anyone read password-reset and platform-MFA codes (account takeover incl. platform owner)**
Security · **P1 (P0 if any review deployment holds real users/data)** · Auth, platform admin · DEPLOY_VERCEL.md:43-45 ("review hardened like production … mandatory admin MFA").
Expected: deployed builds never disclose one-time codes. Actual: on Vercel with Neon and no `APP_ENV`, `src/server/hosting/vercel.ts:49,54` sets `APP_ENV=review` and `DEV_OTP_ECHO=true`; recovery returns the code in the response (`auth/service.ts` `requestRecovery`), public `GET /api/v1/auth/dev-outbox?destination=` lists any address's latest codes, and platform WhatsApp MFA echoes its code (`platform/mfa.ts:62-65`); seed creates `admin@luma.demo` as platform_owner. Impact: anyone knowing an email can reset it and pass MFA on a review URL. Remediation: never echo codes for recovery/MFA when deployed; 404 dev-outbox when deployed; refuse to boot when `VERCEL_ENV=production` and `APP_ENV` unset. Acceptance: with `APP_ENV=review`, recovery response has no code, dev-outbox 404, MFA send has no code. Effort: small. Dependencies: decision on demo sign-in for review builds (§9 Q9).

**LUMA-AUDIT-002 — Eight platform policy routes skip platform MFA**
Security · P1 · Platform admin (policy reviewer/owner) · PLATFORM_ADMIN (mandatory admin MFA).
Expected: all `/api/v1/platform/**` use `platformRoute()` (`requirePlatformMfa`). Actual: `policies/rules`, `rules/[id]`, `appeals`, `appeals/[id]/resolve`, `decisions`, `decisions/[id]/end`, `escalations`, `escalations/[id]/dismiss` use `route({auth:'platform'})`; `route.ts:176-180` checks only role/capability (verified). Platform-wide customer suspensions need only password step-up. Remediation: switch to `platformRoute`; add a test that every platform route uses it. Acceptance: non-MFA session → 403 `mfa_required` on all eight. Effort: small.

**LUMA-AUDIT-003 — Storefront ignores the business's brand colours and fonts**
Defect · P1 · Owner, public storefront, builder · Builder/branding requirement (BUILDER_SCHEMA; onboarding brand step).
Expected: CTA background = saved primary (#1F6F5C), headings in chosen font. Actual: `--sf-primary` is set on the storefront wrapper but CTA renders `rgb(47,42,38)` (fallback) and headings use IBM Plex. Cause: `src/app/globals.css:10` declares `--color-sf-*: var(--sf-*, fallback)` inside `@theme` (not `@theme inline`), so Tailwind v4 resolves them at `:root` where `--sf-*` is undefined (confirmed in compiled CSS). Applies to all `sf-*` colours, fonts, radius. Impact: every storefront looks like the default theme; branding — a core selling point — is visibly broken in demos. Remediation: `@theme inline` for `sf-*` tokens (or utilities referencing `var(--sf-*)`). Acceptance: e2e sets primary #1F6F5C and asserts computed CTA background `rgb(31, 111, 92)` and heading font-family. Effort: small. Evidence: `a/shots/j1-30-public-v1-desktop.png`, `a/specs/audit-a-css.spec.ts`.

**LUMA-AUDIT-004 — "New space" / "Edit space" crash the hosting page**
Defect · P1 · Salon owner, hosting · HOSTING_INVENTORY_DECISIONS req. 9–11.
Expected: listing form opens. Actual: global error page, `TypeError: (f.data ?? []).map is not a function`. Cause: `src/ui/hosting/HostingPage.tsx:230` types `GET /resources` as an array; `catalog/service.ts:317` returns `{types, resources}` (verified). Impact: no salon can list a space through the UI. Remediation: read `.resources`; add a browser test. Acceptance: e2e creates, edits and publishes a space in the UI. Effort: small. Evidence: `b/j6-new-space-crash-no-units.png`.

**LUMA-AUDIT-005 — Staff invitation links lead to 404; invitations cannot be accepted in the UI**
Defect · P1 · Owner/manager, all invited roles · PERMISSIONS (team invitations).
Expected: invitee opens link, signs in, joins with role. Actual: link built as `${APP_URL}/invite/${token}` (`team/service.ts:179`) but no `src/app/invite` route exists (verified); `POST /api/v1/invitations/accept` exists but no UI calls it. Observed 404 in J8. Remediation: add `src/app/invite/[token]/page.tsx` (sign-in → accept → redirect). Acceptance: e2e invite→accept→dashboard with role. Effort: small.

**LUMA-AUDIT-006 — Stores can publish and sell with no payment method; checkout dead-ends while reserving stock**
Defect · P1 · Owner, customer, commerce · Payment flow / publish readiness (PAYMENT_FLOW).
Expected: readiness or cart blocks prepaid checkout until a method exists. Actual: readiness (`onboarding/service.ts` ~l.160) ignores payments; order created and stock reserved 30 min; "Pay now" → "No payment option is available"; other buyers see "out of stock". Impact: lost sales and locked stock for new stores. Remediation: readiness item "payment method connected" or hide prepaid checkout; refuse order creation without a provider. Acceptance: without provider, no reservation is created and the CTA is hidden/blocked. Effort: medium. Evidence: `a/shots/j4-B-after-continue.png`.

**LUMA-AUDIT-007 — No message-delivery provider: production cannot register, recover, invite, or send MFA/reminders**
Incomplete integration · P1 (launch/pilot) · All users · CUSTOMER_EXPERIENCE, auth.
Actual: `infra/messaging.ts:25-31` `providerFor` always null; env enum `EMAIL/SMS/WHATSAPP_PROVIDER` only `none`; production `register` → 503 `verification_unavailable`. Remediation: implement ≥1 email and ≥1 SMS/WhatsApp provider + delivery webhooks. Acceptance: production registration delivers a code; `notification_deliveries.status='sent'`. Effort: medium. Dependencies: provider contracts/credentials (blocked).

**LUMA-AUDIT-008 — No live payment provider; platform billing is manual and upgrades apply without payment**
Incomplete integration · P1 (launch) · Customers, businesses, platform finance · PAYMENT_FLOW.
Actual: registry = sandbox only (refused in production); online deposits unavailable in production; subscriptions are "test invoices" marked paid by an admin; `changePlan` upgrades immediately. Remediation: Moyasar/Tap adapter behind `PaymentProvider`; gate upgrades on charge/pending invoice. Effort: large. Dependencies: merchant accounts (blocked) and billing decisions (§9 Q7).

### P2

**LUMA-AUDIT-009 — Workspace add-ons (products/equipment) cannot be configured in the UI**
Missing approved requirement · P2 · Salon owner, hosting · Decisions D5/D6. Listing form has no add-on editor; API only. Remediation: add-on editor (product from store, equipment resource, price). Acceptance: owner adds both add-on kinds in the form and the expert sees them. Effort: medium.

**LUMA-AUDIT-010 — Finance report omits hosting revenue (salon) and hosting expense (freelancer)**
Defect · P2 · Finance (both parties) · Decisions D3b/D13, req. 17. `hosting/money.ts` posts `hosting_revenue`/`hosting_expense`; `finance/service.ts:113-122` excludes them; observed SAR 87.13 hosting revenue missing from net while its collection is counted. Remediation: add lines + include in net and exports. Acceptance: after a paid workspace booking both reports show the line and net includes it. Effort: small.

**LUMA-AUDIT-011 — Manual stock issue can be posted twice (no idempotency)**
Data-integrity · P2 · Inventory · Req. 4/6 (no duplicate movements). Two identical POSTs → two consumptions (observed 169→168). Remediation: require Idempotency-Key and send from UI. Acceptance: duplicate submit returns the same movement. Effort: small.

**LUMA-AUDIT-012 — Storefront keeps taking bookings/orders when the subscription is lapsed and the dashboard is read-only** *(suspected — code-verified, not executed)*
Data-integrity/product · P2 · Storefront · Subscriptions. `publicTenant()` checks only `tenants.status` (`storefront-public.ts:9-14`); dashboard read-only via `requireWritable`. Remediation: apply the same entitlement rule on public writes. Acceptance: expired subscription → storefront booking POST 404/409. Effort: small. Dependency: decision §9 Q8.

**LUMA-AUDIT-013 — No UI to link a client appointment to a space booking**
Missing approved requirement · P2 · Freelancer · Req. 13. Drawer text tells her to add from "My appointments" but no control exists; API works. Effort: medium.

**LUMA-AUDIT-014 — Freelancer dashboard exposes salon/HR machinery and shows her own schedule as read-only**
UX issue · P2 · Freelancer · EXPERT.md §1, DECISIONS_2026-11 ("لوحة خاصة بها"). Menu shows Payroll, Team (attendance/leave/files), Audit; "My schedule" says "Read-only. Contact management"; base salary/commission and 30 days "Absent"; branch-limit banner; hidden pages (e.g. `/app/<expert>/hosting`) still render via URL. Remediation: hide payroll/HR/branches for solo experts; owner view of own schedule; guard hidden routes. Acceptance: solo expert sees none of these; direct URL shows not-available. Effort: small–medium.

**LUMA-AUDIT-015 — Failed payment returns the customer to checkout with no message**
UX issue · P2 · Customer · PAYMENT_FLOW. `BookingCheckout.tsx` ~l.48 ignores `failed/cancelled`. Acceptance: `role=alert` failure message after simulated failure (bookings and orders). Effort: small.

**LUMA-AUDIT-016 — Session expiry mid-booking is a dead end**
UX issue · P2 · Customer · Booking flow. "Please sign in to continue." with no action; clicks do nothing. Remediation: on 401 switch to the existing sign-in-and-return path. Effort: small.

**LUMA-AUDIT-017 — Published store stays live with no bookable service after archiving**
UX issue · P2 · Owner/customer · Builder readiness. Remediation: warn when archiving the last bookable service on a live site. Effort: small.

**LUMA-AUDIT-018 — Customers cannot choose service variants or add-ons online**
Missing approved requirement · P2 · Customer/storefront · IMPLEMENTATION_STATUS catalog, BOOKING_ENGINE. API supports, UI never sends. Effort: medium.

**LUMA-AUDIT-019 — Platform block on/off switches have no effect**
Defect · P2 · Platform admin/builder. `disabledComponentTypes()` (`platform/templates.ts:134`) never called. Acceptance: disabled block → 422 on add/publish and greyed in Library. Effort: small.

**LUMA-AUDIT-020 — Marketplace commission not reversed when a completed marketplace booking is refunded**
Data-integrity · P2 · Business/platform finance · MARKETPLACE §7 ("not done"). Effort: small–medium.

**LUMA-AUDIT-021 — Two parallel marketing plan systems and 11 Loom tabs**
UX/Incomplete integration · P2 · Owner · LOOM_MARKETING_ARCHITECTURE §19. `/marketing/plans` and `/loom/plans` coexist; engineering tabs (Models, Connections, Jobs) exposed to owners. Dependency: decision §9 Q10. Effort: medium (high uncertainty).

**LUMA-AUDIT-022 — Loom "Analysis status" tab shows "No analyses yet" while analyses succeeded**
Defect · P2 · Owner. Effort: small.

**LUMA-AUDIT-023 — Loom shows money in raw halalas** (e.g. baseline "1676505", "Unit margin 9739")
Defect · P2 · Owner. Effort: small.

**LUMA-AUDIT-024 — Loom shows internal keys and raw JSON** (`inventory.weekly_usage@item:<uuid>`, `ev_…`, raw JSON in version compare)
UX issue · P2 · Owner. Effort: small–medium.

**LUMA-AUDIT-025 — Billing cycle cannot change after signup; subscription billing test-only**
Incomplete integration · P2 · Owner · DECISIONS_2026-11 (monthly/yearly prices). Dependency: proration decision (§9 Q7). Effort: medium.

### P3

| ID | Title | Type | Role/module | Evidence | Remediation / effort |
|---|---|---|---|---|---|
| LUMA-AUDIT-026 | Payment webhook rate-limit keyed on raw `x-forwarded-for`; rejected events each insert a row | Security | Payments | `payments/webhooks/[provider]/route.ts:16`; `service.ts:363-366` | key on `clientIp()`; sample rejects · S |
| LUMA-AUDIT-027 | Account lockout (8 failures/15 min) regardless of IP enables lockout DoS | Security | Auth | `auth/service.ts:19-20,187-193` | per-IP+identifier throttle · S |
| LUMA-AUDIT-028 | TOTP-enrolled admins can still pass MFA with WhatsApp code | Optional enhancement (security) | Platform | `platform/mfa.ts:79-90` | TOTP-only once enrolled · S |
| LUMA-AUDIT-029 | On Vercel, `AUTH_SECRET`/webhook secret derived from DB owner password (suspected rotation hazard) | Security/ops | Deploy | `hosting/vercel.ts:50-51` | require explicit secrets in production · S |
| LUMA-AUDIT-030 | Instagram connect has no OAuth flow or UI caller | Incomplete integration | Expert | `instagram/connect/route.ts` | OAuth start/callback or hide · M |
| LUMA-AUDIT-031 | Version rollback skips reference/readiness checks | Data-integrity (minor) | Builder | `publish.ts:91-94` | run reference checks · S |
| LUMA-AUDIT-032 | Group sessions: on-site payment only; not linked in storefront nav | Missing requirement | Storefront | `groups/service.ts:78` | M |
| LUMA-AUDIT-033 | Packages cannot be edited (archive+recreate breaks offer blocks) | Missing requirement | Owner | packages routes | S |
| LUMA-AUDIT-034 | Status docs contradict code (COGS, plan prices, Loom phases, hosting rewire) | Defect (docs) | All | IMPLEMENTATION_STATUS, README | regenerate from code · S |
| LUMA-AUDIT-035 | Dark mode decided (2026-11-15) but not implemented; DECISIONS_2026-11 still says "no"; many `bg-white` | Missing (decided) | All dashboards | DESIGN_GUIDE.md; `b/ux-workspace-dark.png` | token migration + toggle (planned design pass) · L |
| LUMA-AUDIT-036 | Seeded materials have stock without opening movements (history ≠ balance) | Data (seed) | Inventory | J5 | seed posts `opening` movements · S |
| LUMA-AUDIT-037 | Hosting amounts unclear: unlabelled second price, expense total vs per-salon mismatch, "Salon net" = collected, price check lacks tax/discount breakdown, per-line VAT rounding, outside-window message omits buffers | UX | Hosting | `b/j6-*` | S–M |
| LUMA-AUDIT-038 | Converting an approved opportunity duplicates the initiative (AR+EN) and labels version "Edited by you" | Defect | Loom | J7 | S |
| LUMA-AUDIT-039 | Mixed-language data in English UI (service/staff names, tax label, Loom titles), "1 businesses" | i18n | Owner/customer | `a/snap/j3-*`, J7 | `pick(ar,en)`, ICU plurals · S |
| LUMA-AUDIT-040 | Builder autosave does not resume after reconnect | UX | Builder | `a/shots/f3-builder-offline.png` | retry on `online` · S |
| LUMA-AUDIT-041 | Duplicate accessible names (colour picker + hex both "Primary"; double upload buttons) | Accessibility | Builder/team | `a/snap/j1d-brand.yml` | S |
| LUMA-AUDIT-042 | Builder "Last saved" uses browser clock, rest uses business time | UX | Builder | J1 | XS |
| LUMA-AUDIT-043 | E2E/demo environment does not run the job worker (analyses and hold expiry never progress) | Defect (test/demo infra) | Ops | J7, playwright config | start worker in web server · S |
| LUMA-AUDIT-044 | Platform settings text says every change needs a password, but a login within 10 min counts as step-up | UX | Platform | `STEP_UP_WINDOW_MIN` | adjust copy or behaviour · XS |
| LUMA-AUDIT-045 | Custom domain/subdomain: table exists, no routing, no policy | Unresolved product decision | Storefront | `0007_builder.sql:140` | decide, then L |
| LUMA-AUDIT-046 | Open inventory/hosting decisions: D12 plan matrix unapproved; void/credit note for posted supplier invoices; linked-staff busy for events/groups enforced in app only; Loom link (req. 20) unspecified | Unresolved product decision | Inventory/hosting | HOSTING_INVENTORY_DECISIONS §3 | decide · — |
| LUMA-AUDIT-047 | No committed browser test and no seed data for hosting/workspace journeys | Test coverage | Hosting | `tests/e2e` (no hosting spec), `scripts/seed.ts` | seed one listing + e2e journey · M |
| LUMA-AUDIT-048 | No side-by-side comparison of spaces | Optional enhancement | Freelancer | J2 | M |
| LUMA-AUDIT-049 | Onboarding opens at step 2 with two primary buttons on last screen; onboarding opening hours disagree with specialist schedule (storefront shows "Closed" while slots exist); account list hides payment state; ambiguous cancel dialog buttons; permission 404 shown as "Could not load data" | UX | Owner/customer | `a/shots/j1-08-onb-generate.png` etc. | S each |

Areas verified sound (no finding): RLS coverage and policy logic; `withSystem` confined to jobs/admin/webhooks/self-reads; tenant resolution and capability checks; specialist assigned-only scope; sessions/CSRF/password hashing/OTP handling; rate limiting; idempotency store; append-only audit/financial tables; media authorization and image re-encoding; sandbox webhook HMAC + timestamp + event dedupe + amount match; Loom ingest signatures and SSRF guards; no cross-tenant caches; central customer identity separation; booking/space double-booking prevention via exclusion constraints (executed race).

---

## 7. Integration truth table

| Integration | Classification | Evidence | Without credentials |
|---|---|---|---|
| Payments — sandbox provider | **Sandbox and verified** | Journeys 3/4/6 (pay, fail, replay); HMAC webhook `providers/sandbox.ts:46-68` | Refused when `APP_ENV=production` |
| Payments — Moyasar / Tap / Tabby / Tamara | **Disconnected** | catalogue entries only, `providers/registry.ts:9-19` | Never offered |
| Platform subscription billing | **Mocked** (manual test invoices) | `subscriptions/service.ts:352-413` | n/a |
| Email / SMS / WhatsApp (OTP, invites, reminders, campaigns) | **Disconnected** | `infra/messaging.ts:25-31`; env enum `none` | Dev outbox + on-screen code (dev/review); production → failed / 503 |
| AI (OpenAI-compatible) for Loom/marketing/builder assistant | **Configured but unverified** (adapter, no key) | `infra/ai/index.ts`; J7 `ai-status disconnected/no_api_key` | Rules-based fallback, clearly labelled |
| Loom radar signal APIs (search interest, social trends) | **Disconnected** | `loom/radar/ports.ts:28-48` (env URLs unset, not in `.env.example`) | "Not connected"; starter calendar |
| Loom RSS/user-link sources | Live code path, **unverified** (none configured in audit) | `marketing/trends.ts`, safe-fetch | Works without keys |
| Loom generic CSV/REST connectors & ingest webhook | **Sandbox and verified** (integration tests; not browser-tested) | `loom/connectors/generic/*` | Per-connection secrets |
| Outgoing Loom webhooks | Code path verified in tests; **no external endpoint configured** | `loom/webhooks/*` | Deliveries only when an endpoint is added |
| File storage | **Live (local disk / Postgres table)**; no S3/R2 | `infra/storage.ts` | n/a |
| Maps | **Live, no credentials** (OpenStreetMap embed/links; no geocoding) | `storefront/blocks/info.tsx` | Distance sort needs coordinates (observed) |
| ZATCA | **Phase 1 QR only** (local TLV); Fatoora phase 2 not implemented | `finance/zatca.ts:1-12`; INV-000001 issued | n/a |
| Instagram | **Configured but unverified; connect journey incomplete** | `instagram/provider.ts`; no OAuth/UI | 503 `instagram_not_configured`; profile link |
| Hosting (Vercel/Neon or embedded PGlite) | **Configured, not deployed in audit** | `server/hosting/vercel.ts` | Review defaults → LUMA-AUDIT-001 |
| Scheduled jobs (cron) | **Configured** (GitHub Actions → `/internal/cron`), **not verified** | `.github/workflows/scheduled-jobs.yml` | Endpoint 404 without `CRON_SECRET`; jobs don't run |

---

## 8. Product and UX critique

- **Branding is the most visible gap.** The builder, onboarding and preview all *save* the brand correctly, but the storefront renders the default theme (003). Owners will believe customization is broken.
- **Freelancer simplicity is mostly relabelling.** "مساعداتي", "الاستوديو", "عميلاتي" rename salon concepts, but payroll, HR (attendance/leave/files), audit, branches and branch-limit upsells remain, and her own schedule says to "contact management" (014). A solo-mode that hides team/payroll until an assistant exists would match the stated intent.
- **Admin vs storefront separation is clean** (`/app`, `/s`, `/platform`, `/account`), and draft/published separation is robust (immutable versions; no leak observed).
- **Hosting is functionally deep but not operable end-to-end by a real salon**: space creation crashes (004), add-ons and appointment linking exist only in the API (009, 013), hosting income is missing from Finance (010), and money figures in the hosting screens need labels (037). Once fixed, the flow is strong: clear "No materials are included" terms, held→confirmed→check-in→settlement, correct privacy boundary.
- **Transaction outcomes:** booking and payment statuses are correctly separated in owner and detail views, but the customer list shows only booking status, failed payments are silent (015), and session expiry dead-ends (016). Prices show "Tax SAR 45.65 · Total SAR 350" without saying the tax is included.
- **Loom** matches the intended "plans and recommendations, no chatbot" model and labels rules vs AI honestly, but presents engineering detail to owners (raw halalas, internal keys, raw JSON, 11 tabs including Models/Connections/Jobs, two plan systems) — 021–024.
- **Readiness to sell:** a new store can publish and accept orders without any payment method (006), leading to reserved stock and a dead end.
- **Documentation drift:** status docs understate (COGS, Loom phases) and overstate (plan prices "NULL") what exists (034) — reviewers relying on them will misjudge readiness.
- **Objective accessibility/responsiveness:** 0 horizontal overflow at 375 px across ~25 checked pages in AR/EN, correct `dir/lang`, visible focus, reduced motion respected. Defects are limited to duplicate accessible names (041). Dark mode is not implemented (035).

---

## 9. Decisions required from the owner

1. **Freelancer plans.** Options: (a) keep three business plans for all types; (b) add dedicated freelancer plan(s) with their own price and feature set (e.g. products+inventory, no staff); (c) let experts buy salon plans too. Affects: plan table (needs an audience/business-type column), pricing page, LUMA-AUDIT-014/REQ-B17. Missing: feature list, staff limit, price, monthly/annual.
2. **LUMA / LUMA Plus customer tiers** (note, not approved). Nothing exists for customer subscriptions. Decide: whether to build customer subscriptions at all; price/billing; benefits.
3. **20% LUMA Plus booking discount** (note, not approved). No mechanism supports it. Decide: qualifying condition and source of truth for membership; who funds it (LUMA via commission, business, split) and settlement; marketplace-only vs direct bookings; services only or also products; deposit vs total; stacking with coupons/memberships/gift cards/founding offer; tax base; reversal on cancellation/refund.
4. **Rename demo salon «صالون نورة» → «الروشة».** Display name only (≈3 lines in `scripts/seed.ts`, low risk) vs also slug `noura-salon` and `*@noura.demo` emails (~15 files: seed, e2e/demo specs, docs; invalidates existing demo links/credentials).
5. **Workspace/inventory plan matrix (D12)** — approve or edit the proposed allocation; affects limits and upsell copy.
6. **Posted supplier invoice corrections** — allow void with reversal, or require supplier credit notes; affects AP accuracy.
7. **Subscription billing** — proration and cycle change rules (monthly↔yearly), whether upgrades require payment first; affects LUMA-AUDIT-008/025.
8. **Lapsed subscription behaviour** — should the storefront stop taking bookings/orders, show a closed notice, or keep selling for a grace period? Affects LUMA-AUDIT-012.
9. **Review deployments** — may they ever hold real users? If yes, demo sign-in/on-screen codes must be removed from review builds entirely; if no, they need an explicit "test data only" gate and must never be shared publicly. Affects LUMA-AUDIT-001.
10. **Loom plan store** — keep `/loom/plans` (planner with actions) and retire `/marketing/plans`, or the reverse; and whether Models/Connections/Jobs tabs move to an advanced/admin area. Affects LUMA-AUDIT-021.
11. **Custom domains/subdomains** — none, subdomain per business, or custom domains on higher plans (who handles DNS/TLS verification). Affects LUMA-AUDIT-045.
12. **Messaging and payment providers** — which vendors (e.g. email + WhatsApp/SMS; Moyasar/Tap/Tabby/Tamara) and who holds the merchant accounts (LUMA vs each business). Blocks LUMA-AUDIT-007/008.
13. **Dark-mode record** — confirm the 2026-11-15 decision ("enable with a toggle") supersedes DECISIONS_2026-11 ("لا"), so docs can be reconciled.

---

## 10. Recommended implementation sprint for today

**Must fix** (small, independent, high impact):
- LUMA-AUDIT-002 platform policy routes → `platformRoute` + guard test.
- LUMA-AUDIT-001 stop echoing recovery/MFA codes and close dev-outbox on deployed builds (keep verify-email echo only if decision Q9 allows).
- LUMA-AUDIT-003 storefront theme tokens (`@theme inline`) + computed-style e2e.
- LUMA-AUDIT-004 hosting listing drawer crash + e2e create/edit/publish.
- LUMA-AUDIT-005 `/invite/[token]` page + e2e.
- LUMA-AUDIT-006 payment-method readiness / no reservation without a provider (medium).
- LUMA-AUDIT-011 idempotency on manual issue.
- LUMA-AUDIT-010 hosting revenue/expense in finance report.

**Next** (approved functionality, independent):
- LUMA-AUDIT-009 add-on editor; LUMA-AUDIT-013 link-appointment UI; LUMA-AUDIT-047 hosting seed + e2e (depends on 004).
- LUMA-AUDIT-015, 016, 017 customer/owner feedback states.
- LUMA-AUDIT-022, 023, 024 Loom display defects; 038.
- LUMA-AUDIT-014 freelancer solo-mode (UI hiding is small; full simplification depends on Q1).
- LUMA-AUDIT-019 block switches; 020 commission reversal; 036 seed opening movements; 043 worker in e2e.

**Later** (do not block a pilot):
- LUMA-AUDIT-018 online variants/add-ons; 021 Loom consolidation (after Q10); 026–029 security hardening; 031–033; 035 dark mode + token migration (design pass); 037, 039–042, 044, 048, 049 UX polish; 034 docs regeneration.

**Blocked** (decision, credentials or external action):
- LUMA-AUDIT-007 messaging provider (Q12, credentials).
- LUMA-AUDIT-008 live payments + paid upgrades (Q12, Q7, merchant accounts).
- LUMA-AUDIT-025 billing cycle change (Q7).
- LUMA-AUDIT-012 lapsed-subscription storefront rule (Q8).
- LUMA-AUDIT-030 Instagram OAuth (app credentials).
- AI output (REQ-G07) — API key.
- LUMA-AUDIT-045 custom domains (Q11); LUMA-AUDIT-046 open inventory/hosting decisions (Q5, Q6); freelancer plans, LUMA Plus, discount, rename (Q1–Q4).

Large or externally blocked items (007, 008, 035, 045) should not be expected to finish today.

---

## 11. Handoff summary for the next reviewer

- **Demonstrably works (observed in browser):** sign-up (review mode), business creation, 7-step onboarding, builder draft/preview/publish/version restore without draft leakage, archived-reference fallback; marketplace discovery → booking with mid-flow login, deposit and full payment (sandbox), reschedule, cancel with refund preview, booking/payment status separation; product cart with last-unit protection and paid order; inventory receipt → chair-station transfer → issue with frozen weighted-average costs and valuation = ledger; workspace booking → sandbox payment → QR/code check-in → material sale → settlement → invoices on both sides with balanced journals and host privacy; Loom rules-based plans, opportunity decisions, versions; role/tenant isolation via UI and direct API.
- **Missing:** messaging and live payment providers; real AI; customer variant/add-on selection online; hosting add-on editor and appointment-link UI; custom domains; dark mode; customer subscription tiers (LUMA Plus); dedicated freelancer plans.
- **Broken:** storefront theming (003), hosting listing create/edit (004), staff invitations (005), checkout without payment method (006), manual-issue duplication (011), finance omission of hosting (010), Loom status/amount/key display (022–024).
- **Security:** review-build code echo / account takeover (001), platform policy MFA bypass (002); minor hardening items 026–029.
- **Unverified:** real deployment and cron, AI/Instagram adapters with credentials, AI timeout path, recipe consumption in the browser (integration-tested only), lapsed-subscription storefront behaviour (012), most platform-admin screens.
- **Unresolved decisions:** §9 Q1–Q13 (freelancer plans, LUMA Plus and its discount, demo rename scope, plan matrix, supplier invoice voids, billing proration, lapsed subscription rule, review-build policy, Loom plan store, custom domains, providers, dark-mode record).
- **Likely files to change:** `src/app/globals.css`; `src/ui/hosting/HostingPage.tsx`; `src/app/invite/[token]/page.tsx` (new) + `src/server/domains/team/service.ts`; `src/app/api/v1/platform/policies/**`; `src/server/hosting/vercel.ts`, `src/server/domains/auth/*`, `src/app/api/v1/auth/dev-outbox/route.ts`, `src/server/platform/mfa.ts`; `src/server/domains/onboarding/service.ts`, `src/server/domains/commerce/orders.ts`; inventory manual-issue route/UI; `src/server/domains/finance/service.ts`; `src/ui/storefront/*/BookingCheckout.tsx`, `BookingFlow.tsx`; `src/ui/marketing/Loom*.tsx`; `src/shared/workspace-profile.ts`, `src/ui/shell/nav.ts`; `src/server/infra/messaging.ts`, `src/server/domains/payments/providers/*`; `scripts/seed.ts`; `tests/e2e/*`; `playwright.config.ts`.

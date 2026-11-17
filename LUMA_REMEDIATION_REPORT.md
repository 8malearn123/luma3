# LUMA Remediation Report

Follows `LUMA_AUDIT_REPORT.md` (audited revision `6455e2c`). Finding IDs are the audit's `LUMA-AUDIT-NNN`.

## 1. Current revision and test environment

| | |
|---|---|
| Branch | `claude/clever-ptolemy-cxzufg` (local; **not pushed** — see §8.4) |
| Final revision | `0dcfb84` (27 commits after the audit-report commit `66d9d74`) |
| Full-suite revision | `862e6cb` (all workstreams merged). `0dcfb84` adds only the upgrade gate (008) and documentation; its focused suites were re-run. |
| Environment | Linux cloud container, Node 22, PostgreSQL 16 (local, fresh databases per run), production builds (`next build` + `next start`), headless Chromium via Playwright, job worker started by the e2e server (`tests/e2e/serve.ts`), sandbox payment provider, **no external credentials**. |
| New migrations | 0830 shop payment paths + commission reversals · 0840 finance summary export · 0841 workspace/linked-staff guard (trigger) · 0870 Loom export net platform fee · 0871 customer bookings English staff names |
| Evidence | Committed under `docs/remediation/evidence/{sec,store,shop,host,loom,dark,verify}/` (5.6 MB of screenshots containing seeded/test data only, plus `sec/before-after.txt` and `verify/integrations-status.json`). Regression tests are committed under `tests/`. |

**Final results**

| Check | Result |
|---|---|
| `pnpm typecheck` | clean |
| `pnpm lint` | 0 errors, 12 warnings (11 pre-existing + 1 `window.location.href` redirect, same pattern as existing code) |
| `pnpm test` (unit + integration, real Postgres) at `862e6cb` | **754 / 754 passed, 116 files** (audit baseline: 564 / 565, 99 files) |
| Focused re-run at `0dcfb84` | subscriptions, inventory-locations, hosting: 38 / 38 |
| Playwright e2e, full suite, production build, worker running, at `862e6cb` | **75 / 75 passed** (11.0 min) — 17 spec files (audit baseline: 4 spec files, 13 tests) |

**PDF failure investigation (audit baseline's only failure).** Cause: `src/server/infra/pdf.ts` launches the Chromium build pinned by `playwright-core` 1.56.1 (`chromium_headless_shell-1194`); this container ships build 1243, so launch fails → 503 `pdf_renderer_unavailable`. With `CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium` a real PDF renders. **Deployment relevance:** Vercel has no Chromium (already documented in `docs/DEPLOY_VERCEL.md`), so a deployed build also returns 503 for the PDF and offers the printable HTML (`?format=html`) fallback. Not a code defect; a production PDF needs a renderer decision (§7). The test now asserts `%PDF` whenever Chromium is available or `CI` is set, and otherwise asserts the documented 503 + working HTML contract with an explicit annotation (not a silent skip). `docs/RUNBOOK.md` explains the setting.

## 2. Remediation tracker

Status: **Fixed** (failure reproduced or evidenced, fixed, regression test, browser check where relevant) · **Partial** · **Open** · **Blocked** (credentials/decision) · **Decision**.

| ID | Sev | Title | Status | Fix / evidence (tests) |
|---|---|---|---|---|
| 001 | P1 | Codes exposed on review builds | **Fixed** | `env.ts` `isDeployed` covers review/production/any Vercel deployment; code echo, dev outbox, one-click demo and fixed MFA code only when not deployed; boot fails on unsafe combos (DEV_OTP_ECHO/DEMO_MODE deployed, dev/test APP_ENV on Vercel, Production without APP_ENV, weak/duplicate secrets). Deployed builds: honest "not available" for registration/recovery; TOTP MFA; demo accounts password-only (R3). Before: recovery returned `dev_code`, dev-outbox 200. Tests: `env-safety` (11), `deployed-auth` (6); browser review-build check (`evidence/sec/review-0*`). **Exposure:** undetermined — needs Vercel logs (R8: deployed preview untouched); affected configurations listed in `docs/DEPLOY_VERCEL.md`. |
| 002 | P1 | Platform policy routes skip MFA | **Fixed** | 8 routes → `platformRoute`; MFA now enforced inside `route()` for every platform route before step-up and input parsing (new finding: 39 routes leaked validation details pre-MFA). Test enumerates every platform route module and makes real requests: 107 route-method pairs → 401 / 404 / 403 `mfa_required` (base: 47 failures). Browser: `platform-policies.spec.ts`. |
| 003 | P1 | Storefront ignores brand colours/fonts | **Fixed** | `@theme inline` for `sf-*` + storefront radius. Before: CTA `rgb(47,42,38)`. `storefront-identity.spec.ts` checks computed colours/fonts/radius, two tenants, draft vs published, preview vs live, 1440/375. |
| 004 | P1 | "New space" crashes | **Fixed** | `GET /hosting/listing-options`; loading/error/empty states. `hosting-journey.spec.ts` creates, edits, publishes a space entirely in the UI. |
| 005 | P1 | Invitation link 404 | **Fixed** | `src/app/invite/[token]/page.tsx` + `InviteAccept`; recipient check; tenant/role from record only. `invitations.test.ts` (7: recipient, escalation attempt, wrong identity 403, signed-out 401, expired/revoked/used/invalid, token hashed) + `invite-journey.spec.ts`. Delivery remains disconnected; owner copies the link (shown only to the signed-in owner). |
| 006 | P1 | Selling without a payment path | **Fixed** | Payment eligibility from real configured methods (adapter-backed accounts; sandbox never in production) + on-site when allowed (R2). No usable path → 422, nothing created/reserved; pay-at-pickup orders (24 h hold — §7); revalidated at payment; owner readiness item + record-payment dialog; honest customer states. `shop-remediation` tests + e2e. |
| 007 | P1 | No messaging provider | **Blocked** (vendor/credentials) | Deployed builds now state the unavailability honestly instead of echoing codes (001). |
| 008 | P1 | No live payments; upgrades free | **Partial / Blocked** | Fixed: owner self-upgrade outside the trial → 409 `upgrade_requires_payment`; platform `change_plan` is the administrative grant (`subscriptions.test.ts`). Blocked: live payment provider and paid billing (vendor, merchant accounts, billing rules). |
| 009 | P2 | Add-on editor missing | **Fixed** | Product (store price + listing discount) and equipment add-ons in the listing form; e2e. |
| 010 | P2 | Finance omits hosting | **Fixed** | `hosting_revenue` / `hosting_expense` lines with basis text, in profit and new summary export; reconciled to journal; no double counting. `hosting-finance.test.ts`, e2e. |
| 011 | P2 | Manual issue duplicates | **Fixed** | Idempotency-Key required; UI reuses key on retry, rotates on change; reused key with different payload → 422. Concurrent retries → one movement; separate keys → two issues. Also fixed a deadlock between genuinely parallel issues. Integration + e2e. |
| 012 | P2 | Lapsed subscription still sells | **Fixed** (R4) | `requireStorefrontSelling` on bookings, orders, groups, gift cards, memberships, event requests, waitlist acceptance; grace period honoured; store shows notice. `storefront-lapsed.test.ts`. |
| 013 | P2 | No UI to link client appointment | **Fixed** | "Add a client appointment in this space" in the space booking drawer; window/buffer explanation; host sees no client data; e2e. Linking a pre-existing overlapping appointment is impossible by the `space_key` constraint, so the appointment is created inside the space. |
| 014 | P2 | Freelancer sees salon machinery | **Fixed** (R5) | Server-side workspace mode: hosting never; payroll/attendance/leave/HR/staff files only with an active assistant; no branches UI; own schedule editable on "My schedule"; hidden routes show "not available" and APIs return 403. Root cause of the audit's contradiction: studio hours editable in Settings vs staff schedule read-only on `/me`. `expert-solo-mode.test.ts` (5) + e2e. |
| 015 | P2 | Silent payment failure | **Fixed** | `role=alert` failure + retry in booking and order checkout; 2 e2e tests. |
| 016 | P2 | Session-expiry dead end | **Fixed** | 401 → sign-in-and-return with saved selection; availability and price re-validated; e2e. |
| 017 | P2 | Live store with nothing bookable | **Fixed** | Archive warning, owner banners, themed "booking not available" page with contact links; integration + e2e. |
| 018 | P2 | No online variants/add-ons | **Fixed** | Storefront flow sends variant/add-ons; server quote is authoritative; foreign add-on rejected; dashboard-equal duration/price; e2e. |
| 019 | P2 | Component switches ignored | **Fixed** | Enforced on draft add, publish and Library; integration + e2e. |
| 020 | P2 | Commission not reversed | **Fixed** (R1) | Proportional append-only reversals per refund, half-up, never above original, idempotent, serialised; refund-before-completion handled. Loom export nets reversals (0870). Tests: partial, full, repeated, out-of-order. |
| 021 | P2 | Two plan systems / 11 tabs | **Partial — Decision** | Inspection + recommendation (Loom planner as canonical, legacy frozen, nothing deleted) in `docs/LOOM_CORE.md` §8.1; primary tabs first, configuration under **Advanced**; re-analyse uses the Loom planner. Scheduler still uses the legacy pipeline pending decision. |
| 022 | P2 | Analysis status wrong | **Fixed** | Real job state (analyses, planner runs, legacy jobs). Integration + e2e (analysis completes via worker). |
| 023 | P2 | Raw halalas in Loom | **Fixed** | Registry-based units/labels, `moneyText`, `useLoomFmt`; e.g. "Completed sales (net) SAR 16,991.13". Unit + e2e. |
| 024 | P2 | Internal keys / JSON | **Fixed** | Readable metric/evidence labels; human version diff; e2e asserts no `ev_`, `@item:`, `{"`. |
| 025 | P2 | Billing cycle immutable | **Blocked** (billing rules decision) | — |
| 026 | P3 | Webhook rate-limit spoofable | **Fixed** | `clientIp()`; rejected deliveries aggregated per provider/reason/10 min. `webhook-abuse.test.ts` (base: 605 rows inserted). |
| 027 | P3 | Lockout abuse | **Fixed** | Per IP+identifier throttle + per-account exponential delay exempting known-good addresses; reset on success. 2 tests (fail on base). |
| 028 | P3 | WhatsApp MFA after TOTP | **Fixed** | TOTP-only once enrolled; tested. |
| 029 | P3 | Secrets derived from DB password | **Fixed** | `AUTH_SECRET` required; sandbox secret independent or sandbox disabled; dependency/rotation table in `docs/DEPLOY_VERCEL.md`, `.env.example`. App-role DB password still derived (documented). |
| 030 | P3 | Instagram connect incomplete | **Blocked** (app credentials) | — |
| 031 | P3 | Rollback skips checks | **Fixed** | Same gates as publish (readiness, references, components, plan); restore-to-draft returns warnings. Behaviour change: rollback requires readiness (§7). |
| 032 | P3 | Group sessions on-site only | **Open** | Not in this sprint. |
| 033 | P3 | Packages not editable | **Fixed** (R7) | PATCH with optimistic concurrency, audited; bookings keep snapshots; UI drawer; integration + e2e. |
| 034 | P3 | Docs contradict code | **Fixed** | README, IMPLEMENTATION_STATUS (inventory, finance, Loom, orders, loyalty, packages), DESIGN_GUIDE, DECISIONS (dark mode), RUNBOOK, TEST_PLAN, DEPLOY_VERCEL, PAYMENT_FLOW, MARKETPLACE, HOSTING decisions updated. |
| 035 | P3 | Dark mode | **Fixed** (2026-11-15 decision) | Semantic tokens + Appearance toggle (cookie, SSR, no flash); 628 class replacements across 147 files; temporary compatibility layer removed; storefront stays tenant-themed. `dark-mode.spec.ts`: 93 page checks, 6,230 text/background pairs ≥ AA. |
| 036 | P3 | Seed lacks opening movements | **Fixed** | Seed uses `createMaterial`; ledger = valuation on e2e DB; e2e check. |
| 037 | P3 | Hosting amounts | **Fixed** | Calculation defects first: expense total vs per-salon (accrual vs cash) unified on journal; VAT split now post-discount (8718→8696 unit test); salon net = charges − platform fee; refunds now reverse tax (new finding). Then labels and pre-booking breakdown. Tax/rounding basis documented (HOSTING decisions §4). |
| 038 | P3 | Convert duplicates item | **Fixed** | Idempotent conversion, business language, one initiative per artifact, accurate provenance labels. |
| 039 | P3 | Mixed-language data | **Fixed** | CLDR plurals; localized names in owner tables, Loom, booking summaries/checkout (read paths return English staff names; snapshots untouched); localized tax labels. |
| 040 | P3 | Autosave after reconnect | **Fixed** | Backoff + `online` retry; explicit 409 choice; 2 e2e tests. |
| 041 | P3 | Duplicate accessible names | **Fixed** | Distinct names for colour/hex, uploads; dialogs named by title; multi-service specialist labels. |
| 042 | P3 | Builder clock | **Open** | Not addressed. |
| 043 | P3 | Worker not started in e2e/demo | **Fixed** | `tests/e2e/serve.ts` starts app + worker; documented; analysis completes in e2e. |
| 044 | P3 | Step-up copy | **Open** | Not addressed. |
| 045 | P3 | Custom domains | **Decision** | — |
| 046 | P3 | Open hosting/inventory decisions | **Partial** | Linked-staff vs group/event race proven and closed by trigger 0841 (`hosting-conflicts.test.ts`). D12 matrix and supplier-invoice correction remain decisions. |
| 047 | P3 | No hosting e2e/seed | **Fixed** | Seeded listing K-1 on «الروشة» (`noura-salon`) with add-ons; `hosting-journey.spec.ts` (6 tests). |
| 048 | P3 | No space comparison | **Open** (optional) | — |
| 049 | P3 | Onboarding/account UX | **Fixed** | Resume explanation, single primary action, hours-vs-schedule warning (hours stay separate by design), "Keep booking", payment state in account list, "not available here" for 404. |
| — | — | Demo rename | **Done** | Display «الروشة», legal «مؤسسة الروشة (اسم تجريبي)», tagline; slug/emails/credentials unchanged. |

**New issues found and fixed during remediation:** pre-MFA validation leak on 39 platform routes; hosting refunds left VAT in `tax_payable`; expert appointments inside a space were always left on hold; deadlock between parallel manual issues; group-session vs space race; plan drawer re-analyse used the legacy pipeline; customer booking list showed superseded (rescheduled) items; e2e suite exceeded the per-IP login limit (per-file client address in tests; limit unchanged); test-order dependency in `inventory-recipe` settings.

**Totals:** 49 findings — 38 Fixed, 3 Partial (008, 021, 046; 008's live-provider part is blocked), 3 Blocked (007, 025, 030), 4 Open (032, 042, 044, 048), 1 Decision (045). P0/P1 security and core-journey defects (001–006) are all fixed; 007/008 remain blocked by external providers.

## 3. Verification gaps from the audit

| Gap | Result | Requirement ref | Evidence |
|---|---|---|---|
| Platform-admin workflows incl. policies & appeals | **Implemented and tested** | PLATFORM_ADMIN.md, policy docs | `platform-policies.spec.ts` (5): MFA gate, TOTP enrolment, businesses/plans/integrations, criterion, decision with step-up, customer appeal, reviewer resolution, early end |
| Recipe-based consumption in the browser | **Implemented and tested** | HOSTING_INVENTORY req. 6 | `inventory-recipe.spec.ts`: one −5 ml movement from the chair station, no double deduction |
| Multi-service bookings, different specialists | **Implemented and tested** | BOOKING_ENGINE | `shop-remediation.spec.ts` (DB shows two staff) + integration |
| Workspace conflicts with other reservation types | **Implemented and tested** (race found and closed) | D1b, req. 14 | `hosting-conflicts.test.ts`: internal booking, shared equipment, group session (trigger 0841); event bookings share the path, not separately tested |
| Freelancer storefront customization | **Implemented and tested** | BUILDER_SCHEMA | `storefront-customization.spec.ts` test 1 (computed styles; other tenant unchanged) |
| Provider behaviour where configured | **Not applicable** — no live provider configured | — | `verify/integrations-status.json` |
| Customer payment restrictions through checkout | **Implemented and tested** | PAYMENT_FLOW restriction rules | `shop-remediation.spec.ts` (deposit policy, full payment required, on-site, deposit-required strengthening) |
| Natural-language storefront customization | **Blocked** (AI credentials); approved/specified | PERMISSIONS (`feature.customization_ai`), BUILDER_SCHEMA | spec test 2: "Not connected", disabled input, 503 `ai_unavailable`, nothing stored |
| Loyalty on product orders | **Implemented and tested** (R6) | owner decision R6 | `loyalty-orders.spec.ts` (3): earned at collection, reversed on refund |

## 4. Completed approved functionality (this sprint)

Payment eligibility with pay-at-pickup (R2); proportional commission reversal (R1); lapsed-subscription grace behaviour (R4); freelancer solo mode (R5); loyalty on orders (R6); package editing (R7); online variants/add-ons; invitation acceptance; hosting add-on editor, appointment linking and seeded demo listing; finance hosting lines and summary export; dark mode with toggle; platform component switches; rollback validation; autosave recovery; Loom readable display, real job status and Advanced area; worker in e2e; demo rename; owner self-upgrade gate.

## 5. Remaining defects and gaps

- **032** group sessions: on-site payment only, not in storefront nav (P3).
- **042** builder "Last saved" uses the browser clock (P3); **044** platform step-up copy (P3); **048** no side-by-side space comparison (optional).
- No dashboard action to refund a product order; approving a return does not refund (staff API only) — UX gap.
- Supplier invoice void/credit note, period close, landed cost: finance remains an **operational ledger**, not full accounting.
- Event bookings vs rented chair: same guarded code path as group sessions, not separately tested.
- `tests/demo/*` (embedded PGlite two-instance suite) was rewritten for password + TOTP but **not run** in this sprint.
- Compliance: ZATCA phase 1 QR only; **legal/tax compliance is unverified** — no requirements established beyond the QR.

## 6. External integration status

| Integration | Status |
|---|---|
| Payments — sandbox provider | **Sandbox verified** (bookings, orders, hosting, refunds, failure path) |
| Payments — Moyasar / Tap / Tabby / Tamara | **Disconnected** |
| Platform subscription billing | **Mocked** (manual test invoices); upgrades gated (owner trial-only, platform grant) |
| Email / SMS / WhatsApp | **Disconnected** (local dev echo only; deployed builds report unavailable) |
| AI (OpenAI-compatible; Loom planner, builder assistant) | **Configured unverified** — adapter present, no key; UI reports "not connected" |
| Loom radar APIs / external trend sources | **Disconnected** |
| Instagram | **Disconnected** (no OAuth flow; credentials absent) |
| File storage (local / Postgres) | **Live verified** (local) |
| Maps (OpenStreetMap links) | **Live, no credentials** |
| ZATCA | Phase 1 QR only; Fatoora **disconnected** |
| PDF renderer | Local Chromium verified when configured; **unavailable on Vercel** (HTML fallback) |
| Cron/worker | Worker **verified locally** (e2e); deployed cron (GitHub Actions → `/internal/cron`) **configured unverified** |

## 7. Unresolved decisions (concise questions)

1. **Messaging:** which provider(s) and channel for verification/recovery (one reliable channel is enough to start)?
2. **Payments:** which provider, and who holds merchant accounts (LUMA or each business)?
3. **AI & trends:** provide AI credentials and approve external trend sources?
4. **Paid upgrades & billing cycle:** proration, monthly↔yearly switching, payment before upgrade (owner upgrade outside trial is currently refused).
5. **Freelancer plans:** dedicated plans and feature allocation?
6. **LUMA / LUMA Plus customer memberships:** build or not; price and benefits?
7. **20% Plus discount:** qualifying condition, funding, stacking, eligible bookings, tax base, refund reversal?
8. **Custom domains:** none, subdomains, or custom domains on higher plans?
9. **Supplier invoice correction:** void with reversal or supplier credit notes?
10. **Plan matrix (D12):** approve the proposed inventory/hosting feature allocation?
11. **Loom plan store (021):** adopt the Loom planner as canonical and switch the scheduler?
12. **Pay-at-pickup hold:** keep 24 h placeholder?
13. **Publishing requires a payment path:** keep as a blocking readiness item (pay-on-site counts)?
14. **Rollback requires readiness** like publish — keep?
15. **PDF in production:** keep HTML print fallback or choose a serverless PDF renderer?
16. **Commission/reversals in the business journal:** post them or keep platform-side only?
17. **Retained late-cancellation fee (hosting):** VAT-inclusive with a credit note for the refunded part?
18. **Linked specialist while her chair is rented:** may she run group sessions/events elsewhere at the same time? (now refused)
19. **Freelancer payroll after the only assistant leaves:** keep payroll visible until open entries are closed? Hide the audit log for solo freelancers? Confirm group sessions are unavailable to freelancers.
20. **Deployed admin security:** first TOTP enrolment of a seeded admin is password-protected only; give `admin@luma.demo` its own demo password?
21. **Product-order refunds:** add a dashboard refund action?

## 8. Readiness verdicts

Evidence base: 754/754 automated tests, 75/75 browser tests on a production build, all P0/P1 code defects fixed; external providers disconnected.

| Stage | Verdict | Basis |
|---|---|---|
| **Internal demonstration** | **READY** (local or embedded demo with sandbox payments and the worker running) | All eight audited journeys plus hosting, inventory recipe, platform policies, loyalty, dark mode pass in the browser; storefront branding, space creation, invitations and payment readiness are fixed; demo data (incl. hosting listing) is seeded. A *deployed* review build now requires `AUTH_SECRET` and `APP_ENV` in Vercel and offers password-only demo accounts (no sign-up/recovery without messaging). |
| **Limited pilot** | **NOT READY** | Blocked by messaging (no registration/recovery/invite delivery in deployed builds) and live payments (no online deposits/prepayment; pay-on-site only). Security blockers (001/002) are fixed in code but not yet deployed. Once a messaging provider is connected, a pilot limited to pay-on-site businesses becomes possible, subject to decisions 1, 2, 4, 10, 12, 13. |
| **Commercial launch** | **NOT READY** | Additionally needs paid billing, ZATCA phase 2 and an established compliance basis, production PDF decision, and the commercial decisions in §7. |

### 8.4 Push status

All work is committed locally on `claude/clever-ptolemy-cxzufg` and **not pushed**, per the owner's instruction to hold pushes until the demo version is finished. Pushing triggers a Vercel preview deployment, which will refuse to start until `AUTH_SECRET` (and `APP_ENV` on Production) are set and any `DEV_OTP_ECHO` / `DEMO_MODE` variables are removed (steps in `docs/DEPLOY_VERCEL.md`). The currently deployed preview (built from the audited code) still contains finding 001 and was left untouched (R8).

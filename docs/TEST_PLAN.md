# Test plan

## Suites

| Suite | Location | Runner | What it exercises |
|---|---|---|---|
| Unit | `tests/unit/*.test.ts` (3 files) | Vitest | Pure modules: the availability engine, the capability model, i18n dictionaries |
| Integration | `tests/integration/*.test.ts` (24 files) | Vitest | Route handlers called **in process** through `TestClient` (`tests/helpers/http.ts`, with cookies and CSRF headers) and domain services, against a **real PostgreSQL** database with RLS, constraints and triggers |
| E2E | `tests/e2e/*.spec.ts` (2 files) | Playwright | Browser journeys against `next dev` on port 3110 with a seeded `_e2e` database |

**Integration setup**: `tests/setup/global-setup.ts` migrates `TEST_DATABASE_OWNER_URL` and truncates every table except `schema_migrations`, `plans` and `plan_features`. It **refuses** a database whose name does not end in `_test`. `tests/setup/env.ts` sets `APP_ENV=test`, `DEV_OTP_ECHO=true`, `DEMO_MODE=false`, a test webhook secret, empty AI settings, and `STORAGE_LOCAL_DIR=./storage-test`. Files run serially (`fileParallelism: false`), so concurrency tests control their own parallelism. Helpers live in `tests/helpers/` (`factory.ts` with `signup` and `createBusinessFor`, plus `salon.ts`, `commerce.ts`, `policy.ts`, `platform.ts`, `loom.ts`, `marketing-data.ts`). AI tests inject a fake provider with `setAiProviderForTests`. Trend tests inject a fake resolver and transport, so **no network is used**.

## Observed results (2026-10-21)

Run by the documentation worker in its own worktree, against a scratch database `luma_d_test`, with the vitest command from the README (`TEST_DATABASE_URL` / `TEST_DATABASE_OWNER_URL` pointing at `luma_d_test`, credentials elided):

| Command | Result |
|---|---|
| `pnpm exec vitest run` | **27 test files passed (27); 193 tests passed (193)**; 0 failed, 0 skipped. Duration 148.4 s (a second run with `--reporter=verbose` also gave 27/27 files and 193/193 tests, in 205.6 s). |
| `pnpm typecheck` (`tsc --noEmit`) | **Passed** (exit code 0, no errors) |
| `pnpm test:e2e` | **Not run by the documentation worker.** Another process uses the E2E database and port. The last E2E result is recorded by the main engineer. |

Per-file test counts (unit 24 + integration 169 = 193):

| File | Tests | File | Tests |
|---|---:|---|---:|
| unit/booking-engine | 14 | integration/finance | 2 |
| unit/capabilities | 8 | integration/infra | 6 |
| unit/i18n | 2 | integration/marketing-ai | 11 |
| integration/analytics | 6 | integration/notifications | 1 |
| integration/auth | 6 | integration/payment-terms | 12 |
| integration/booking | 12 | integration/payments | 8 |
| integration/builder | 14 | integration/platform | 12 |
| integration/campaigns | 5 | integration/policy | 14 |
| integration/commerce-inventory | 7 | integration/settings-support | 5 |
| integration/commerce-orders | 12 | integration/subscriptions | 6 |
| integration/commerce-payments | 3 | integration/tenancy | 8 |
| integration/customers | 7 | integration/trends | 4 |
| integration/demo | 3 | integration/waitlist-groups | 2 |
| integration/engagement | 3 | | |

## Acceptance areas → tests

Test names are quoted from the `describe` / `it` / `test` titles.

### Tenant isolation and permissions

| Requirement | Test |
|---|---|
| A member of one business cannot read or modify another, even with guessed ids | tenancy › "a member of one business cannot read or modify another business, even with guessed ids" |
| Business creation, owner and trial; verified account required; browser-supplied role ignored | tenancy › "creates a business with the caller as owner and a trial subscription", "requires a verified account and ignores any browser-supplied role", "rejects duplicate and reserved slugs" |
| Confidential costs | tenancy › "receptionist cannot see confidential service costs; owner can"; commerce-orders › "receptionist manages orders without seeing costs; specialist cannot access orders", "a manager without costs.view cannot set costs; …" |
| Invitations and delegation | tenancy › "an invitation only works for the verified identity it was sent to", "managers cannot be granted owner-only or non-delegable capabilities" |
| Capability matrix | unit/capabilities (8 tests: receptionist defaults, specialist assigned-only, delegation allowlist, finance, revocations, role assignment, platform least privilege, read-only support) |
| Another business cannot read or transition a booking | booking › "another business cannot read or transition this booking" |
| Specialists see only assigned bookings | booking › "specialists only see and act on their assigned bookings" |
| Customer isolation across businesses | customers › "a customer at two businesses: each sees only its own relationship; /account sees both", "a specialist (even with customers.view) cannot read private notes; a receptionist can", "walk-in creation never reveals whether a phone or email has a LUMA account" |
| Support access | settings-support › "no grant → 404; read grant reads but cannot mutate; write grant actions audited with grant id; revoked/expired → 404"; platform › "a support grant is unusable from a session that has not passed MFA" |
| Platform invisibility and least privilege | platform › "every /api/v1/platform handler returns 404 to a tenant owner and to a plain customer", "nobody can self-grant a platform role …", "support admin cannot edit plans or grant roles; policy reviewer cannot view revenue", "role grants need platform_owner + fresh step-up, are audited, and the last owner cannot be removed", "the bootstrap CLI logic grants roles with a system audit record" |
| Admin MFA | platform › "enrols, rejects wrong codes, stores the secret encrypted, and requires per-session verification", "the platform owner can reset another admin's MFA (step-up, audited)" |
| Account suspension | platform › "suspending an account signs it out and ends its support access; reactivation restores sign-in" |

### Authentication

| Requirement | Test |
|---|---|
| Register, verify (dev-labelled code), sign in | auth › "registers, verifies with the (dev-labelled) code, and signs in" |
| CSRF | auth › "rejects mutations without the CSRF header"; analytics › "dedupes by event_id and requires the CSRF header; …" |
| No account enumeration | auth › "does not reveal whether an account exists on duplicate registration", "recovery responds identically for unknown accounts" |
| Lockout and rate limits | auth › "locks the account after repeated failures and rate limits" |
| Recovery revokes sessions | auth › "recovers a password and revokes old sessions" |
| Demo switcher off in production | demo › "is absent when DEMO_MODE is off", "is absent in production even if DEMO_MODE is on", "never signs into a non-demo account" |

### Availability, booking, lifecycle

| Requirement | Test |
|---|---|
| Algorithm (shift end, breaks, leave, buffers, qualification, overrides, notice and window, timezone, resources, any-staff rule, multi-service gaps, no partial sequences, itinerary validation) | unit/booking-engine (14 tests) |
| Only feasible times; other appointments hidden | booking › "returns only feasible times and hides other appointments" |
| **No double booking under concurrency** | booking › "two concurrent holds for the same slot: exactly one wins" |
| Idempotent holds | booking › "same idempotency key replays the same hold instead of creating a second" |
| Rejections | booking › "rejects unqualified staff, past times and staff on approved leave" |
| Multi-service | booking › "multi-service booking with different specialists discloses gaps" |
| Hold expiry exactly once | booking › "expired holds release exactly once and free the slot" |
| No-show timing, completion and audit | booking › "no-show is blocked before start + grace; completion and audit work" |
| Check-in day; revenue posted once | booking › "check-in only on the appointment day; complete posts revenue once" |
| Customer cancellation ownership | booking › "customer can cancel her own booking only; another customer cannot" |
| Reschedule rollback | booking › "rescheduling keeps the original when the replacement is unavailable" |

### Payments, deposits, policy

| Requirement | Test |
|---|---|
| Deposit arithmetic | payment-terms › "rounds half up in integer halalas and never exceeds the amount due" |
| Terms priority and reason codes | payment-terms › default terms; require_full_payment; fixed deposit collapse; blocked contact path; require_deposit strengthened; expired/superseded ignored; strictest across tenant + platform; suspend_account; tenant sees platform action only; orders never take deposits; reassessment on change |
| Server-computed deposit; the redirect proves nothing | payments › "deposit: server computes the amount; success confirms via webhook; the redirect alone proves nothing" |
| Webhook security and dedupe | payments › "rejects forged, stale-timestamp and malformed webhooks; duplicates are no-ops" |
| Amount/currency/account matching | payments › "amount, currency or account mismatch is flagged for review and does not confirm" |
| Late success | payments › "late success after hold expiry: confirms if the slot is still free, refunds if it was taken" |
| On-site collection | payments › "on-site collection needs a reference and cannot exceed the balance" |
| Refund cap under concurrency | payments › "refunds are capped and deduplicated even when requested concurrently" |
| Snapshot terms on cancellation | payments › "customer cancellation uses the terms captured at booking time" |
| Reconciliation | payments › "reconciliation applies a capture whose webhook was lost" |
| Incidents, decisions, appeals | policy (14 tests: no-show incident validity, cross-tenant incident rejection, review notes and audit, self-review, escalation creates no decision, platform evidence only when escalated, salon owner cannot create platform decisions, step-up for decisions, platform reviewer + step-up + owner for suspension, platform reasoning hidden, expiry/review sweep, appeals routing and outcomes) |

### Commerce, inventory, finance, engagement

| Requirement | Test |
|---|---|
| Stock never negative under concurrent checkout | commerce-orders › "one unit, two concurrent checkouts: exactly one succeeds, stock never negative, loser gets out_of_stock" |
| Idempotent checkout, price-change acknowledgement, quantity rules, cart merge, cross-tenant variants | commerce-orders (5 tests) |
| Exactly-once expiry, cancellation and payment | commerce-orders › "expiry run twice releases stock once", "failed payment cancel called twice releases once", "markOrderPaid twice → one sale; …", "cancelling a paid, uncollected order puts the goods back on the shelf" |
| Order payment wiring; captured-after-cancel refund; conversion session | commerce-payments (3 tests) |
| Inventory and coupons | commerce-inventory (7 tests: unit conversion, capacity estimate, material consumption exactly once, receipts/adjustments/low stock, permissions and plan gate, coupon validation, per-customer limit and max redemptions under concurrency) |
| Finance | finance › "reports deposits as liabilities, says "costs incomplete" honestly, and voids expenses by offset", "finance is confidential: receptionists cannot read reports; exports need step-up and are protected" |
| Loyalty, gift cards, memberships | engagement (3 tests) |
| Waitlist and group sessions | waitlist-groups › "offers a freed slot to one consenting customer at a time; acceptance needs an atomic hold", "never overbooks under concurrency and blocks the instructor for individual bookings" |
| Plan limits and subscription lifecycle | subscriptions (6 tests: branch limit, downgrade overage, overage resolution, trial → past_due → expired → reactivated, platform actions, test-mode invoices) |
| Settings | settings-support › "versioned writes (409 on stale), validation …", "a manager without business.manage gets 403 …", "branches: weekly hours …", "tenant audit log is paginated and filterable" |

### Builder, AI, marketing, analytics

| Requirement | Test |
|---|---|
| Draft concurrency, unsafe blocks, permissions | builder › first 3 tests |
| Publishing, readiness, live prices, hidden categories, invalid stored configuration, preview tokens, rollback and restore | builder › "publishing & public read model" (5 tests) |
| Page limits, powered-by, templates | builder › "pages & plan policy" (3 tests) |
| Assistant: disconnected 503, whitelist and injection, forbidden-only output | builder › "customization assistant" (3 tests) |
| AI adapter honesty, retries, rate limits, tenant cache | infra › "AI adapter" (4 tests) |
| Job runner retries and dedupe | infra › "job runner" (2 tests) |
| Loom without AI, insufficient data, permissions | marketing-ai › "Loom pipeline without AI" (3 tests) |
| Loom with a fake AI: honest states, budget fallback, injection, number validation, versioning, cache isolation, price proposals, scheduled idempotency | marketing-ai (8 tests) |
| SSRF and trends | trends (4 tests) |
| Campaign rules and results | campaigns (5 tests) |
| Analytics definitions, exclusions, occupancy, employee indicators | analytics (6 tests) |
| Notifications | notifications › "creates an in-app notification and records simulated deliveries exactly once" |
| i18n parity | unit/i18n › "every Arabic key has an English counterpart and vice versa" |

### E2E (Playwright)

Projects: `desktop` (Desktop Chrome, all specs) and `mobile` (Pixel 7, `responsive.spec.ts` only). Locale is `ar-SA`. Global setup (`tests/e2e/global-setup.ts`) refuses non-`_e2e` or non-local databases and production, drops and recreates the schemas, migrates and seeds (credentials go to `./.e2e/credentials.json`).

| Spec | Tests |
|---|---|
| `booking-journey.spec.ts` | "a selection made before signing in survives sign-in and is re-validated"; "customer books from the published storefront and pays in the sandbox; confirmation comes from the server"; "a signed-out visitor is sent to sign in before reserving, never shown another customer's data"; "staff role boundaries: a specialist cannot open finance; a customer cannot reach the platform admin"; "owner sees the dashboard overview for her business" |
| `responsive.spec.ts` | "RTL + mobile: {path}" for `/`, `/pricing`, `/s/noura-salon`, `/s/noura-salon/services`, `/s/noura-salon/booking`, `/s/lamar-makeup` and `/auth/login` (status < 400, `dir="rtl"`, no horizontal scroll, no page errors); "English switches direction to LTR"; "preview links are not indexable and unknown storefronts 404" |

## What is covered, by level

- **Unit**: the availability engine (pure), the capability matrix, i18n key parity.
- **Integration**: everything server-side listed above. Every test goes through real SQL, RLS, exclusion constraints, deferred journal balance, append-only triggers and idempotency records. Concurrency is tested for holds, checkout stock, refunds, coupon redemptions, loyalty redemption and group seats.
- **E2E**: the customer booking and sandbox payment journey, sign-in resume, role boundaries in the UI, RTL and mobile layout, LTR switch, preview `noindex`, storefront 404.

## Not covered by automated tests

- **Real providers**: there are no real payment, messaging or AI provider tests, because none are connected. AI is tested with a fake provider only, and the sandbox is the only payment path.
- **Worker process**: `scripts/worker.ts` (the loop, signal handling, multiple workers) is not tested end to end. `runDueJobs` and `runOutbox` are tested only through `infra` and domain tests. Periodic tasks are called directly, not on schedule.
- **Stuck `running` jobs**: there is no reclamation logic, so nothing to test.
- **PDF rendering** (`renderPdf`, Chromium) and the CSV export file contents beyond the permission checks.
- **Media upload pipeline** (`POST assets`: `sharp` WebP re-encoding, size and type rejection). `/api/v1/media/{id}` authorisation is covered only for evidence (policy) and private exports (finance), with assets inserted directly.
- **Scripts**: `seed.ts` is exercised indirectly by E2E global setup only; `reset-dev.ts` guards and `migrate.ts` checksum mismatches have no tests.
- **Booking side paths**: manual `approve` → conversion event (not recorded), rescheduling price-change acceptance (`price_changed` 409 and `acceptTotalMinor`), membership no-show handling, and group session cancellation refunds.
- **Commerce**: the return approval path with restock is exercised inside "markOrderPaid twice → one sale; …". Rejection of a return and partial-return refunds have no dedicated test.
- **Gift cards and memberships**: online purchase (not implemented).
- **Dashboard UIs** for bookings, services/team, finance/engagement, the staff portal and account booking detail have no E2E coverage (those UIs are being completed in parallel).
- **Accessibility audits** (contrast in the rendered UI, screen readers), cross-browser runs beyond Chromium, performance and load tests.
- **Security**: the CSP headers (`next.config.ts`) and the health endpoint have no automated assertions apart from E2E server start-up waiting on `/api/v1/health`.

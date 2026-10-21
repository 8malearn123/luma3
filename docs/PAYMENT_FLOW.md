# Payment flow

| File | Role |
|---|---|
| `src/server/domains/policy/payment-terms.ts` | Payment-terms algorithm (re-exported by `booking/terms.ts`) |
| `src/server/domains/payments/service.ts` | Checkout, capture application, webhooks, refunds, reconciliation |
| `src/server/domains/payments/providers/{registry,sandbox,types}.ts` | Provider adapters |
| `src/server/domains/finance/{journal,postings,service,documents}.ts` | Double-entry journal, revenue recognition, invoices, exports |
| `src/server/domains/commerce/orders.ts` | `markOrderPaid`, cancellation, expiry |
| `src/server/domains/giftcards/service.ts`, `memberships/service.ts`, `loyalty/service.ts` | Stored value and engagement |

> **Only the LUMA Sandbox provider is connected.** It is a simulation that moves no money. The business is the merchant of record for customer payments (`payment_accounts.settlement_owner = 'merchant'`). LUMA's own subscription billing is separate and also test-only (`platform_invoices` CHECK `is_test`).

## Providers (`providers/registry.ts`)

| Provider | Integrated | Note |
|---|---|---|
| `sandbox` | **yes** | LUMA test provider: moves no real money. Hosted "checkout" is a LUMA page labelled as a simulation. |
| `moyasar` | no | Requires a merchant account and API verification |
| `tap` | no | — |
| `tabby` | no | BNPL requires an agreement |
| `tamara` | no | BNPL requires an agreement |

Only registered adapters can be resolved by `provider(name)`. Connecting any provider other than `sandbox` returns 503 `provider_not_integrated`. Card data never touches LUMA: checkout is always hosted by the provider.

## 1. Payment terms algorithm

`computePaymentTerms(trx, { tenantId, tenantCustomerId, customerUserId, amountDueMinor, availableMethods, context: 'booking' | 'order' })`, algorithm version `1`.

**Inputs**

1. **Available methods** (`enabledMethods`): the `enabled_methods` of active payment accounts, plus `cash` and `pos_terminal` when `tenant_settings.allow_pay_on_site` is set.
2. **Business policy**: `deposit_mode` (`none`, `percent`, `fixed`), `deposit_percent_bp`, `deposit_fixed_minor`, `allow_full_prepay`, `allow_pay_on_site`, `hold_ttl_sec`.
3. **Active decisions** for the customer: tenant-scope rows in `policy_decisions` (by `tenant_customer_id` or `customer_user_id`), plus platform-scope decisions through `app.platform_decisions_for_customer()`. That function exposes only the action and the customer-facing explanation. Only `status = 'active'` decisions inside their effective/expiry window count; superseded, revoked and expired decisions are ignored.

**Priority** (`ACTION_RANK`, strictest wins across **both** scopes):

| Action | Rank | Effect |
|---|---|---|
| `suspend_account` (platform only) | 3 | Blocks payment entirely |
| `require_full_payment` | 2 | Removes `deposit` and `on_site` |
| `require_deposit` | 1 | Removes `on_site`. If no deposit is configured, or the deposit equals the total, it is **strengthened** to full prepayment, never weakened. |
| `default` | 0 | No restriction. A tenant `default` never cancels a platform restriction. |
| `manual_approval` | additive flag | Combines with any rank; the booking goes to `pending_approval` |

When ranks tie, a platform decision is preferred as the decisive one (for the explanation).

**Deposits**: `percent` = `floor((amount × bp + 5000) / 10000)` (half-up in integer halalas). `fixed` = the configured amount. Both are capped at the amount due. A deposit of 0 means "no deposit"; a deposit equal to the amount collapses into full prepayment. **Orders never take deposits.**

**Options** (`full`, `deposit`, `on_site`):

- `full`: needs an online method, and `allow_full_prepay`, a rank of 1 or more, or a business deposit policy.
- `deposit`: needs an online method and a deposit strictly between 0 and the amount.
- `on_site`: needs `cash` or `pos_terminal`, `allow_pay_on_site`, and **no** business deposit policy.
- Amount 0: only `full` (reason `nothing_due`).
- No compatible option: `blocked = true`, `contact_path = 'contact_business'`.

**Output** (`PaymentTerms`): `allowed[]`, `depositMinor`, `amountDueMinor`, `requiresManualApproval`, `blocked`, `reasonCodes[]`, `decisionIds[]`, a bilingual `customerExplanation` (the decision text or a generic one, plus the appeal path `/account/policy` or a "contact the business" tail), `policySnapshot` (algorithm version, methods, deposit settings, effective action, decisions as scope + action only), `computedAt`, and `validUntil = computedAt + hold_ttl_sec`.

**Reason codes** (exact strings): `tenant_decision:<action>`, `platform_decision:<action>`, `no_online_method`, `no_on_site_method`, `on_site_disabled_by_business`, `business_deposit_policy`, `deposit_equals_total`, `account_suspended`, `nothing_due`, `restriction:full_payment_required`, `restriction:deposit_required`, `deposit_unavailable_full_required`, `no_compatible_method`, `manual_approval_required`.

**Re-assessment**: `reassessPaymentTerms()` and checkout's `materialChange()` compare `allowed`, deposit, amount, manual approval and blocked. **The browser can never re-enable an option**: checkout re-checks the chosen option against server-computed terms (`requireAllowedOption`).

## 2. Booking checkout

`POST /api/v1/s/{slug}/bookings/{id}/checkout` (verified user, `Idempotency-Key` required) → `checkoutBooking()`:

1. Lock the booking. It must belong to the caller, be `held`, and the hold must not have expired (otherwise 409 `hold_expired`).
2. Recompute terms for `total − paid`. If they changed materially since the hold, store the fresh terms and return **409 `terms_changed`** so the customer re-confirms.
3. If `blocked`: 422 `payment_blocked` with the explanation. If the chosen option is not allowed: 422 `payment_option_not_allowed`.
4. `on_site`, or nothing due: `applyHoldOutcome` → `confirmed`, or `pending_approval` when manual approval is required. No payment row is created.
5. `full` / `deposit`: the **server** computes the amount (the deposit or the full balance). It creates a `payments` row (`pending`, then `requires_action`), calls `provider.createCheckout()`, stores `provider_payment_id` and `checkout_url`, adds a `payment_attempts` row, and moves the booking to `pending_payment`. The hold and its allocations are kept, and the payment `expires_at` equals the hold expiry.

Order checkout (`checkoutOrder`) follows the same pattern for a `pending_payment` order. It is always full payment and must happen before the order expires (30-minute window, `ORDER_PAYMENT_TTL_MIN`).

### The redirect is never proof of payment

The provider redirects the customer back with `?return=…`, but nothing is confirmed by that redirect. `GET /api/v1/s/{slug}/payments/{id}` (payer only) reports the **server** state of the payment and its booking or order. Confirmation happens only when a verified webhook (or reconciliation) applies the capture.

## 3. Sandbox provider and webhooks

`providers/sandbox.ts`:

- `createCheckout` inserts a `sandbox_provider_payments` row (`initiated`) and returns `/sandbox/checkout/{id}?return=…`.
- The simulation endpoints `POST /api/v1/sandbox/checkout/{providerPaymentId}` (`captured` / `failed` / `cancelled`) and `POST /api/v1/sandbox/refunds/{providerRefundId}` (`succeeded` / `failed`) update the simulated provider record, build the **signed** webhook a provider would send, and pass it through the normal `handleWebhook()`. Both return 404 when `APP_ENV=production`.

### Webhook intake

`POST /api/v1/payments/webhooks/{provider}` runs server to server, without cookies or CSRF. It is rate-limited to 600 per minute per forwarding IP and accepts bodies up to 256 KB. `handleWebhook()`:

1. **Signature**: header `x-sandbox-signature: t=<unix>,v1=<hex>`, where `v1 = HMAC-SHA256(PAYMENT_SANDBOX_WEBHOOK_SECRET, "<t>.<raw body>")`, compared with `timingSafeEqual`. The secret must be at least 16 characters.
2. **Timestamp tolerance**: `|now − t| <= 300 s`; otherwise "timestamp outside tolerance".
3. **Shape**: `id`, `type` and `data.payment_id`, `data.amount` (safe integer), `data.currency`, `data.account`. Types: `payment.captured`, `payment.failed`, `payment.cancelled`, `refund.succeeded`, `refund.failed`.
4. A rejected webhook is stored in `provider_events` as `ignored` with `signature_valid = false`, and the response is 400 `invalid_webhook`.
5. **Dedupe**: insert into `provider_events` with `ON CONFLICT (provider, provider_event_id) DO NOTHING`. A duplicate returns `{ status: 'duplicate' }` and has no effect.
6. **Resolve the tenant** through `app.payment_by_provider_ref` / `app.refund_by_provider_ref`. An unknown reference is marked `needs_review`.
7. **Match**: the payment's `amount_minor`, `currency` **and** beneficiary account (`payment_accounts.merchant_ref`, or the account id) must equal the event's. On a mismatch the payment is flagged `needs_reconciliation` (`webhook_mismatch:<type>`), finance and refund approvers are notified, the event is marked `needs_review`, and **nothing is confirmed**.
8. **Apply** under a row lock on the payment:
   - `payment.captured`: no-op if already captured. Otherwise set `captured`. If the payment had already reached a final state (`failed`, `cancelled`, `expired`), it is captured anyway and flagged `captured_after_<status>`. Then `applyCaptured()`.
   - `payment.failed` / `payment.cancelled`: **never downgrade a captured payment**. An out-of-order failure after capture is `ignored`. Otherwise set the status; a `pending_payment` booking returns to `held` so the customer can retry before the hold expires. Orders are left for the expiry sweep.
   - `refund.succeeded` / `refund.failed`: amount and currency must match the refund. A refund already in a final state is `ignored`. Success runs `applyRefundSucceeded()`.
9. The `provider_events` row is marked `processed`, `ignored`, `needs_review` or `failed` (with the error).

### Applying a capture (`applyCaptured`)

Shared by webhooks, on-site collection, gift-card redemption and reconciliation. It locks the payment, then:

| Target | Effect |
|---|---|
| Booking | `paid_minor += amount`; `payment_status` becomes `paid`, `deposit_paid` or `partially_paid`. Journal: Dr cash/clearing, Cr `customer_deposits` (or `accounts_receivable` if the booking is already `completed`). If the booking is `held` / `pending_payment`, `applyHoldOutcome` confirms it (or moves it to `pending_approval`). If it is `expired`, the capture is a **late success**. If it is `cancelled` / `no_show`, the payment is flagged `captured_after_booking_closed` and **fully refunded automatically**. |
| Order | `paymentTargets.order.onCaptured` → `markOrderPaid`. Journal: Dr cash/clearing, Cr `product_revenue` (net) + `tax_payable`. A capture on an order that is already **cancelled** is flagged `captured_after_order_cancelled` and **refunded automatically**; it is never kept. |
| Gift card / membership | Calls `paymentTargets.giftCard` / `.membership`. **These are not wired** (they throw). They are not reached, because those products are sold only at the counter (see below). |

The cash account in the journal depends on the method: `cash` → `cash_on_hand`, `gift_card` → `gift_card_liability`, anything else → `provider_clearing`.

### Late success after hold expiry

If a capture arrives after the hold expired (`applyHoldOutcome` throws `hold_expired`, or the booking is already `expired`):

1. `tryReallocateExpired()`, inside a savepoint: release the old allocations and re-insert the **same times** as `confirmed`, in stable order. If the exclusion constraint allows it, the booking is `confirmed` (event `late_payment_reallocated`).
2. If the slot was taken (`23P01`), roll back to the savepoint, flag the payment `late_success_slot_taken`, cancel the booking (system), request a **full automatic refund** and notify the payer.

## 4. On-site collection

`POST /api/v1/t/{slug}/payments/on-site` (`payments.collect`, `Idempotency-Key` required): method `cash` or `pos_terminal`, a **required reference**, and an amount no larger than the balance due (otherwise `amount_exceeds_due`). The payment row records `collected_by` (enforced by a DB CHECK) and is applied immediately with `applyCaptured`.

## 5. Refunds

- Staff request: `POST /api/v1/t/{slug}/refunds` (`refunds.request`, idempotency key required). If the requester also holds `refunds.approve`, the refund is approved at once; otherwise it waits in `requested` until `POST /refunds/{id}/approve` (`refunds.approve`).
- System refunds (cancellation policy, reschedule price decrease, late success, captures after cancellation) are approved automatically, with deterministic idempotency keys (for example `policy:<booking>:<payment>:<basis>`, `auto-late:<payment>`).
- **Cap under concurrency**: `requestRefundInternal` locks the payment row (`FOR UPDATE`) and checks `amount + sum(non-failed, non-cancelled refunds) <= payment.amount_minor`. Otherwise it returns 422 `refund_exceeds_payment` with the refundable amount. Concurrent requests serialise on that lock. The idempotency key (unique per tenant) deduplicates retries. Only captured payments can be refunded.
- **Sending**: cash, terminal and gift-card refunds succeed immediately. Cash is handed back at the counter, and gift-card refunds restore the card balance (never cash). Provider refunds go to `provider.refund()` and stay `pending` until the `refund.succeeded` webhook.
- **`refund_pending` is not refunded**: booking `payment_status` / order `refund_status` show pending while any refund is `requested` or `pending`. Only `succeeded` refunds move `refunded_minor` and post to the journal.
- When money actually moves back, the `onRefundSucceeded` hooks reverse loyalty points proportionally and restore gift-card balances.

## 6. Reconciliation

`reconcileTenant(tenantId)`: the periodic task `payments.reconcile` runs every 6 hours for tenants with non-on-site payments in the last 2 days. Staff can also run it with `POST /api/v1/t/{slug}/payments/reconcile` (`finance.view`). For each non-on-site payment of the last 30 days it calls `provider.fetchPayment()`:

| Finding | Action |
|---|---|
| Missing at the provider | Discrepancy `missing_at_provider` |
| Amount or currency differ | Discrepancy `amount_mismatch` |
| Provider `captured`, LUMA not captured (lost webhook) | **Repaired**: lock, set captured, `applyCaptured` |
| LUMA `pending` / `requires_action`, past `expires_at`, not captured at the provider | Marked `expired` |
| `needs_reconciliation` already set | Reported with its note |

Each run stores a `reconciliation_runs` row with status `balanced` or `discrepancies`, `{ checked, repaired }` and the discrepancy list. (The comment in `payments/jobs.ts` says "daily"; the interval in code is 6 hours.)

## 7. Order payments

`markOrderPaid(trx, tenantId, orderId, payment)`:

- `cancelled` → `{ changed: false, reason: 'order_cancelled' }`. The payments service then flags the payment and refunds it.
- Already past `pending_payment` / `draft` → `already_paid`, with no second sale.
- A partial amount only increases `paid_minor` (event `payment_recorded`).
- Otherwise it settles: each active stock reservation becomes a `sale` (`on_hand −= q`, `reserved −= q`) exactly once, and the order becomes `paid`. Collecting the order later does not touch stock again.
- On change, a server-side `order_paid` analytics event is recorded under the order's `analytics_session_id`.

A failed payment does not cancel the order; the customer may retry until the order expires. `commerce-expire-orders` (every 60 s) cancels unpaid orders past `expires_at` and releases stock exactly once.

## 8. Gift cards and memberships

**Gift cards** (`feature.gift_cards`):

- Issued **by staff only** (`POST /api/v1/t/{slug}/gift-cards`, `giftcards.manage`, idempotency key required), paid in `cash` or `pos_terminal` with a reference, or issued as `complimentary` with a reason. The code (about 80 bits) is shown **once**; only an HMAC (`code_hash`) and the last 4 characters are stored.
- Journal at sale: Dr cash/clearing, Cr `gift_card_liability`. Complimentary: Dr `discounts`, Cr `gift_card_liability`.
- Redemption (customer at checkout, or staff with `payments.collect`) is partial: `min(requested, due, balance)`. It creates a captured payment with method `gift_card` and a `redeem` ledger entry, exactly once per idempotency key. Balance checks and redemptions are rate-limited (10 per 15 minutes per key).
- Void (step-up): the remaining balance is released Dr `gift_card_liability`, Cr `discounts`. Expiry (`giftcards.expire`, hourly): breakage is Dr `gift_card_liability`, Cr `service_revenue`.
- **Not implemented**: online gift-card purchase by customers.

**Memberships / prepaid packages** (`feature.memberships`):

- Sold **by staff at the counter** (`POST /api/v1/t/{slug}/memberships`, cash or terminal with a reference). Entitlements are created from the plan snapshot. Journal: Dr cash/clearing, Cr `membership_liability`.
- Applying to a **held** booking reserves one session per eligible item (`used + reserved <= total` CHECK), turns the item price into a discount, and recomputes the payment terms.
- Completion consumes the reservation and recognises `price_paid / total_sessions`: Dr `membership_liability`, Cr `service_revenue`. Cancellation, no-show and expiry release the reservation. (The code comment says no-show "consumes per policy", but the implementation releases it.)
- `memberships.expire` (hourly) expires memberships past `ends_at`.
- **Not implemented**: online membership purchase. `GET /api/v1/s/{slug}/membership-plans` lists plans publicly, but there is no purchase endpoint.

**Loyalty** (`feature.loyalty`): points are earned once on a **paid, completed booking**, using `floor(SAR × points_per_currency_unit)`. They are reversed proportionally on refund, expire after a period of inactivity (`loyalty.expire-inactive`, every 6 h), and are redeemed into single-use coupons under a row lock. The service comment mentions earning on collected orders, but **no order earning is wired**.

## 9. Journal postings

`post()` writes one `entry_group_id` and rejects unbalanced or mixed lines in code. The deferred constraint trigger `financial_entries_balanced` re-checks every group at commit. The ledger is append-only; corrections are new groups (`reverses_group_id`).

| Event | Debit | Credit | Where |
|---|---|---|---|
| Booking payment before completion | `provider_clearing` / `cash_on_hand` / `gift_card_liability` | `customer_deposits` (**liability**) | `applyCaptured` |
| Booking payment after completion | same | `accounts_receivable` | `applyCaptured` |
| Service completed (once, `booking_completion`) | `customer_deposits` (prepaid part, net of refunds) + `accounts_receivable` (unpaid part) | `service_revenue` (net) + `tax_payable` | `recognizeBookingRevenue` |
| Cancelled / no-show, money retained under policy (once, `booking_retained`) | `customer_deposits` | `service_revenue` | `recognizeRetainedOnClose` (not for `expired`; pending refunds are excluded) |
| Refund before recognition | `customer_deposits` | cash/clearing | `applyRefundSucceeded` |
| Refund after completion; any order refund | `refunds` (contra-revenue) | cash/clearing | `applyRefundSucceeded` |
| Order payment | cash/clearing | `product_revenue` (net) + `tax_payable` | `applyCaptured` |
| Gift card sold / complimentary / void / expired | see section 8 | | `giftcards/service.ts` |
| Membership sold / session delivered | cash/clearing → `membership_liability`; `membership_liability` → `service_revenue` | | `memberships/service.ts` |
| Commission earned | `commissions_expense` | `commissions_payable` | `earnCommissions` |
| Expense recorded / voided | `operating_expenses` / offset | cash | `finance/service.ts` |

- **Deposits are a liability**: a collected deposit is not service revenue until the service is completed. The finance report shows `deposits_outstanding` with that explanation.
- **Revenue recognition at completion** happens exactly once per booking (`alreadyPosted('booking_completion')`).
- **Retained fees**: whatever is paid minus refunded minus pending refunds when a booking is cancelled or marked no-show. Because the refund hook runs first, this equals the policy fee.
- **Commission precedence**: staff+service (4) > staff only (3) > service only (2) > business default (1). Only active rules effective on the booking date count. The base is the item's share of `total − tax` (after discount, excluding tax). Percent rules use `rate_bp`; fixed rules use `amount_minor`. One `earned` entry per booking item (partial unique index); the rule is snapshotted on the entry. Reversals are explicit `reversal` entries created by staff (`POST finance/commissions/{id}/reverse`, `finance.manage`). They are **not** created automatically when a refund succeeds, although the comment in `postings.ts` says "refunds create explicit reversal entries".
- **Tax split**: `splitTax(gross, tax, total)` = `tax = round(gross × tax / total)`, `net = gross − tax`, using the booking or order totals computed with the snapshot rule.
- **Not implemented**: the journal comment lists a COGS posting (Dr `cogs`, Cr `inventory`), but no code posts to `cogs`, `inventory` or `material_costs`. Material consumption moves stock only, and the finance report computes consumption cost from stock movements. `provider_fees` and `owner_equity` are also never posted. The `payouts` table is unused.

## 10. Invoices, receipts and exports

- **Receipt** (`POST finance/receipts`, `finance.view` or `payments.collect`): one per captured payment (partial unique index). The amount is the payment amount, and `tax_basis` notes that the tax breakdown is on the invoice.
- **Invoice** (`POST finance/invoices`): one per **completed** booking, built from the booking snapshot. `tax_basis` holds the policy snapshot. A unique index for order invoices exists, but **no order invoice is issued** by code. `credit_note` is an allowed kind, but **no code issues credit notes**.
- Documents are immutable (append-only). The seller snapshot holds legal name, tax number, address and contacts.
- **Print/PDF**: `invoiceHtml()` produces a self-contained RTL/LTR document. `GET finance/invoices/{id}/pdf` renders it with headless Chromium (`playwright-core`); if no Chromium is available, it returns 503. The footer states that no e-invoicing compliance is claimed.
- **Exports** (`POST finance/exports`, `finance.export`, **step-up**): CSV for `bookings`, `payments`, `journal` or `expenses` over a period, stored as a **private** asset and audited.
- **Finance report** (`GET finance/report`, `feature.finance_reports`): it says "costs incomplete" when product or service costs are unknown.

## Known risks and inconsistencies

- The sandbox account can be connected with `APP_ENV=production` (`connectSandbox` has no production gate). The simulation endpoints are disabled there, so such payments would never complete except through a correctly signed webhook.
- The sandbox simulation endpoints accept any signed-in user for any `providerPaymentId` / `providerRefundId`; there is no payer or tenant check. They are development-only, but anyone who knows an id can settle a sandbox payment in a non-production environment.
- `src/server/domains/payments/targets.ts` refers to `./wiring.ts`, which does not exist. The wiring is in `src/server/boot.ts`.

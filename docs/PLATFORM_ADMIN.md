# LUMA administration — phase 2

Implements the platform-side items of [DECISIONS_2026-11.md](DECISIONS_2026-11.md): approved plan prices, founding customers, promotions, platform analytics and reports, platform-wide bookings and payments, settlements for split payments, referrals and marketers, platform settings (maintenance, sign-ups, approvals, marketplace verification) and a live activity feed.

Migration: `db/migrations/0630_platform_admin_ext.sql`. Integration tests: `tests/integration/admin-pricing.test.ts`, `admin-ops.test.ts`, `admin-referrals.test.ts`.

All `/api/v1/platform/**` endpoints below use `platformRoute()`: callers without a platform role (or without the specific capability) get **404**, then the MFA gate (`mfa_required`), then password step-up where marked. Cross-tenant reads run in `withSystem(...)` with a reason; every change and every export writes an `audit_logs` row. New capabilities are listed in [PERMISSIONS.md](PERMISSIONS.md#platform-roles).

## 1. Prices, yearly billing, founding customers, promotions

| Plan | Monthly | Yearly (two months free) |
|---|--:|--:|
| Sanaa (سناء) | 199 SAR | 1,990 SAR |
| Wahaj (وهج) | 399 SAR | 3,990 SAR |
| Fareed (فريد) | 799 SAR | 7,990 SAR |

- Prices are **data**: 0630 fills `plans.price_monthly_minor` / `price_yearly_minor` (halalas, VAT-inclusive) only where they were still `NULL`, and sets `price_is_test = false`. The owner edits them in `/platform/plans` (`PUT /api/v1/platform/plans/{id}`, step-up).
- **No monthly booking limit** on any plan: there is no booking-limit feature key; the pricing page and plans page state it.
- **Billing cycle** is chosen when the business is created (`billing_cycle` on `POST /api/v1/tenants`; the pricing page toggle passes it through `/app/new?cycle=yearly`). Invoices use the yearly or monthly list price accordingly.
- **Founding customers** (`subscriptions.founding_number`, `founding_discount_bp`, `founding_lost_at`):
  - The first `founding_seats_total` (default **100**) *paying* subscribers get `founding_discount_bp` (default **30%**) off every invoice. A seat is assigned once, when the subscription first becomes paying: its first LUMA invoice is issued, or the platform activates it (`ensureFoundingSeat`, serialised by an advisory lock; unique seat numbers).
  - The discount lasts while the subscription stays current. A DB trigger sets `founding_lost_at` when the subscription becomes `cancelled` or `expired`; the discount is then gone for good and **the seat is not handed to anyone else** (remaining = total − seats ever assigned). `past_due` and `paused` keep the seat.
  - Remaining seats are public (`GET /api/v1/pricing`, `/pricing`) and visible in `/platform/plans` with the holders (`GET /api/v1/platform/founding`).
- **Promotions** (`plan_promotions`): a time-limited % discount (`starts_at`–`ends_at`), optionally limited to plans, billing cycles, a number of paid cycles (`duration_cycles`, NULL = whole subscription) and redemptions. With a `code` the customer enters it (or arrives with `/pricing?promo=CODE`); without a code it is **automatic** (the best running offer applies). It is fixed on the subscription at creation (`promotion_id`, `promotion_discount_bp`, `promotion_cycles_remaining`); an invalid code is a 422 `promotion_invalid`.
- **Invoice amount** = list price × (1 − founding) × (1 − promotion), rounded to the halala (`chargeFor` in `domains/platform/pricing.ts`). `platform_invoices` now stores `list_amount_minor`, `discount_minor` and `discount_detail`. Platform invoices remain test-only (`is_test` CHECK from 0500): no real charging exists yet.

Endpoints: `GET /api/v1/pricing` (public), `GET/POST /api/v1/platform/promotions`, `PATCH /api/v1/platform/promotions/{id}` (plans.manage, step-up, versioned), `GET /api/v1/platform/founding`.

## 2. Platform analytics (`/platform/analytics`, `platform.analytics.view`)

`GET /api/v1/platform/analytics?from&to[&format=csv]` (Asia/Riyadh calendar days, default last 30 days, max 366):

| Metric | Definition |
|---|---|
| Bookings by category | Non-draft/held/expired bookings created in the period, by the category of their current items (category names as each business wrote them) with line revenue |
| Bookings by city | Same bookings by the business's city |
| Trial → paid conversion | Subscriptions created in the period that are `active` now or ever reached `active` |
| Provider retention | Of businesses with bookings in the previous equal-length period, the share with bookings in this period; plus the share of subscriptions that existed at the start and are still current |
| Average rating | Published reviews created in the period |
| Peak hours | Bookings by local start hour (and weekday heatmap) |
| Revenue | Paid LUMA invoices + marketplace fees (fee adapter, below); VAT-inclusive |

## 3. Reports (`/platform/analytics` › Reports, `platform.analytics.view`)

`GET /api/v1/platform/reports/{kind}?from&to[&format=csv]`, kinds: `monthly_revenue` (subscriptions + fees per month, VAT and net), `vat_summary` (output VAT at 15% inside VAT-inclusive subscription and fee revenue), `provider_performance` (per business: bookings, completed, cancelled, no-shows, completed value, rating, fees, cancellation rate), `bookings` (month × status × source). CSV columns ending in `_minor` are exported as `_sar` major units.

## 4. Platform-wide bookings and payments (`/platform/activity`, `platform.activity.view`)

`GET /api/v1/platform/activity/bookings` and `/payments`, filters `tenant` (slug), `status`, `source` (booking source; payment purpose), `method` (payments), `from`/`to` (created date), paging, `format=csv` (up to 10,000 rows, audited as `platform.export`).

**Privacy:** no customer name, contact data, `customer_note`, `internal_note` or private notes are selected; rows carry the business, readable number, statuses, source, money and dates only. Granted to `platform_owner` and `support_admin`.

## 5. Settlements for split payments (`/platform/settlements`, `platform.settlements.manage`)

Model: LUMA collects online payments through a payment intermediary that pays each provider directly and keeps LUMA's marketplace fee.

- `POST /api/v1/platform/settlements {from, to, tenant?}` (re)generates one `settlement_statements` row per business with activity: **gross** = captured online payments (method not `cash` / `pos_terminal` / `gift_card`) in the period, **refunds** = succeeded refunds of such payments, **fee** = marketplace fee (capped at gross − refunds), **net** = gross − refunds − fee (DB CHECK). Status `simulated` rows are recomputed on every generation.
- `POST /api/v1/platform/settlements/{id}/settle {reference}` (step-up) records the intermediary's transfer reference and freezes the statement (`settled`); regeneration never touches settled rows.
- `GET /api/v1/platform/settlements[?format=csv]` (totals included) and `GET /api/v1/platform/settlements/{id}?format=html` — a bilingual, print/PDF-ready HTML statement with the payment lines (booking/order number, no customer data).

## 6. Referrals and marketers

- **Referrers** (`referrers`): a LUMA **marketer** (affiliate, created by the platform; `tenant_id` NULL, visible only in system scope) or a **business** (created automatically the first time its owner opens «الإحالة»; RLS lets the business read its own row). Each has a unique `code` and link `{APP_URL}/r/{code}`.
- **Capture at sign-up:** `/r/{code}` sets the httpOnly cookie `luma_ref` (30 days) and redirects to registration → `/app/new?ref=code`. `POST /api/v1/tenants` uses `referral_code` from the body, else the cookie. Unknown codes are ignored; self-referrals (the referrer's own account or the referring business's owner) are ignored. One referral per referred business (`referrals.referred_tenant_id` unique).
- **Reward:** when the referred business's **first** LUMA invoice is marked paid, the referrer earns `rate_bp` (per referrer, else the global `referral_default_rate_bp`, default **10%**) of the first paid month (a yearly invoice counts 1/12). Credited once (`referral_ledger_one_reward`).
- **Balance** = sum of the append-only `referral_ledger`. A **withdrawal request** (IBAN `SA` + 22 digits, account name; minimum `referral_min_withdrawal_minor`, default 100 SAR) locks the referrer row, checks the balance and books a `withdrawal_hold`. The platform **approves**, **rejects** (books a `withdrawal_release`, reason required) or **marks paid** (transfer reference) — `POST /api/v1/platform/withdrawals/{id}` with step-up. Manual corrections: `POST /api/v1/platform/referrals/{id}/adjust` (step-up, ledger `adjustment`).
- **Screens:** `/platform/referrals` (leaderboard, referrers with balances, add marketer, edit rate/status, record a marketer's withdrawal, withdrawals queue showing the full IBAN for payout) and the business screen **«الإحالة»** `/app/{slug}/referrals` (owner / `business.manage`: link + copy + WhatsApp share, code, balance, referred businesses by name and status only, withdrawal request with step-up, balance history; IBANs masked).

## 7. Platform settings (`/platform/settings`, `platform.settings.manage`)

Table `platform_settings (key, value jsonb)`; keys, types and defaults in `src/shared/platform-settings.ts` (the defaults apply when a row is missing). `GET` / `PUT /api/v1/platform/settings` (PUT: any subset, step-up, audited with before/after). Reads are cached per process for 5 s (`getPlatformSettings()`), and the local cache is cleared on update.

| Key | Default | Effect |
|---|---|---|
| `platform_name` | `LUMA` | Shown on settlement statements |
| `maintenance_mode` | `false` | **Locks business dashboards only**: every tenant API route returns **503 `maintenance`** (with the localized message), and `/app/{slug}/**` pages render a maintenance screen. Storefronts, booking, checkout, customer accounts and `/platform` keep working. LUMA support under a support grant still gets in. |
| `maintenance_message_ar` / `_en` | text | Shown on the maintenance screen and in the 503 details |
| `allow_signups` | `true` | When off, `POST /api/v1/tenants` (new business) returns 403 `signups_closed`. Customer registration is not affected. |
| `require_business_approval` | `false` | When on, new businesses get a `tenant_approvals` row `pending`; they can set up but **cannot publish their storefront** (403 `approval_pending`) until approved at `/platform/settings` (`GET /api/v1/platform/approvals`, `POST /api/v1/platform/approvals/{tenantId}` with step-up; the owner is notified). |
| `founding_enabled`, `founding_seats_total`, `founding_discount_bp` | `true`, `100`, `3000` | Founding customers (section 1) |
| `referral_default_rate_bp`, `referral_min_withdrawal_minor` | `1000`, `10000` | Referrals (section 6) |

## 8. Live activity feed (`platform.feed.view`)

`GET /api/v1/platform/feed?since&limit`: new bookings (non-draft), captured payments, orders, reviews (rating only) and business sign-ups across all tenants, newest first, summary only, each linking to `/platform/tenants?q={slug}`. The header bell (`PlatformFeedBell`) polls every 20 s and counts items newer than the last time it was opened in that browser; `/platform/feed` polls every 15 s. Granted to `platform_owner`, `support_admin` and `technical_admin`.

## Integration with the marketplace

1. **Marketplace fees** come from the `marketplace_commissions` ledger (domains/marketplace) through `src/server/domains/settlements/fees.ts`, used by settlements, analytics and reports.
2. **Booking source `marketplace`**: activity filters and labels accept `source=marketplace` (bookings tagged by the marketplace carry `channel = 'marketplace'`).
3. **Marketplace verification** is a single setting, `marketplace_settings.require_verification`, managed on `/platform/marketplace` (not in platform settings).

## Not covered / limits

- No real billing or payout provider: platform invoices stay test-only, settlements are recorded manually from the intermediary's reports, and referral payouts are bank transfers recorded by reference.
- Marketers have no self-service login; the platform records their withdrawal requests (`POST /api/v1/platform/referrals/{id}/withdrawals`). `referrers.user_id` is reserved for that.
- The feed is polled (no push channel); "new" counts are per browser (localStorage).
- Settings are cached up to 5 s per server instance, so maintenance mode can take a few seconds to reach other instances.

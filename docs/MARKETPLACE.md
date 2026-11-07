# سوق لوما (LUMA marketplace)

Binding decisions: `docs/DECISIONS_2026-11.md` (listing by request + admin approval, specialties from service categories, verification by business type, LUMA commission on marketplace bookings only, per-business rate with a platform default, LUMA collects through a split-payment intermediary).

| Area | Code |
|---|---|
| Migration | `db/migrations/0620_marketplace.sql` |
| Rules (pure) | `src/server/domains/marketplace/rules.ts` |
| Public directory, search, favourites, explore | `src/server/domains/marketplace/directory.ts` |
| Listing, verification, LUMA decisions, settings | `src/server/domains/marketplace/listing.ts` |
| Attribution, commission ledger, `marketplaceFeesFor` | `src/server/domains/marketplace/attribution.ts` |
| Public pages | `src/app/discover/{page,search,salons,experts}` · `src/ui/market/*` |
| Business UI | Settings → «سوق لوما» (`src/ui/settings/Marketplace.tsx`), Finance → «عمولة سوق لوما» (`src/ui/finance/MarketplaceFeesTab.tsx`) |
| Customer UI | `/account/explore` «استكشفي» (`src/ui/account/ExplorePanel.tsx`) |
| LUMA admin UI | `/platform/marketplace` (`src/ui/platform/Marketplace.tsx`), business drawer card (`src/ui/platform/TenantMarketplace.tsx`) |
| Strings | `src/i18n/messages/market.ts` |

## 1. Who appears

A business is listed — in search, the hub, favourites and suggestions — only when **all** hold:

1. `marketplace_listings.status = 'approved'` (a LUMA admin approved its request),
2. `hidden = false` (the business can hide itself at any time without losing approval),
3. `tenants.status = 'active'` and the storefront is **published**,
4. when the platform setting `marketplace_settings.require_verification` is on (**default on**): `tenant_verifications.status = 'verified'`.

The rule is implemented once, in the security-definer function `app.marketplace_directory()`, and repeated for attribution in `attribution.ts#isListed`. Suspending a business, unpublishing, hiding, or switching verification back on removes it immediately; nothing is cached.

### Public data (allowlist)

`app.marketplace_directory()` returns only: slug, name, business type, city (primary branch, else the business city), currency, card tagline, logo (published brand logo, public asset), cover (the listing cover or the first hero image of the published site, public asset), verified flag, published-review rating average and count, starting price (cheapest active visible service), service categories that have an active visible service, a lower-cased search text (name, city, tagline, category and service names), primary-branch coordinates, completed bookings in the last 90 days, approval time.

The API (`GET /api/v1/market/search`) goes further and returns **cards** only: no tenant id, no coordinates (only `distance_km` when the visitor shares a location), no booking counts (used for sorting only). Contacts, owner, documents, IBAN, commission rate and revenue never leave the platform. Tests assert the exact card key set.

## 2. Search, filters and sorts

| Parameter | Meaning |
|---|---|
| `q` | Free text on the search text (name, city, tagline, categories, services) |
| `door` | `salons` = salon + beauty_center + spa; `experts` = expert |
| `type` | One business type |
| `specialty` | A service-category name (Arabic or English, case-insensitive) or category slug. Facets list category names across listed businesses with counts |
| `city` | Exact city (facet) |
| `min_rating` | Average of published reviews ≥ value (unrated businesses count as 0) |
| `price_min`, `price_max` | Starting price in minor units (halalas) |
| `sort` | `best` (text relevance: name > category > other, plus rating × log(count), log(completed bookings), verified), `nearest` (haversine from the browser location, businesses without coordinates last), `top_rated`, `most_booked` (completed, 90 days), `price_asc`, `price_desc` |
| `lat`, `lng` | Browser geolocation, rounded to 0.01° by the client, used only to compute distances; never stored |

Facets (cities, specialties, price bounds) are computed for the door/type scope so filter lists do not collapse while filtering. Filtering and sorting happen in the application on the function's rows (fine for the current scale; a materialised read model can replace the function without changing the API).

## 3. Join requests (listing by request)

Business side (capability `business.manage`, owner only):

- `GET /api/v1/t/{slug}/marketplace` — listing + verification status, blockers, required documents, effective commission rate (read-only).
- `POST /api/v1/t/{slug}/marketplace/request` — `draft|rejected → pending`. Refused with `storefront_not_published`, `business_not_active`, `verification_required` (setting on and not verified), `already_requested`, `already_listed`.
- `PATCH /api/v1/t/{slug}/marketplace` — `hidden`, `tagline_ar`, `tagline_en`, `cover_asset_id` (a public asset of the business).

LUMA side (`platform.marketplace.review`):

- `GET /api/v1/platform/marketplace/listings?status=` and `POST …/listings/{tenantId}/review` `{decision: approve|reject, reason}`. Only `pending` can be reviewed. Rejection needs a reason (shown to the business). Approval re-checks verification when required. The owner is notified in-app; both decisions are audited.

## 4. Verification by business type

| Type | Documents |
|---|---|
| salon, beauty_center, spa | commercial register (`commercial_register`) |
| expert | freelance document (`freelance_document`, وثيقة العمل الحر) |
| all | owner ID (`owner_id`) and IBAN (`iban`: the number, ISO 13616 mod-97 checked, Saudi IBANs 24 characters, plus a bank certificate) |

- Upload: `POST /api/v1/t/{slug}/marketplace/verification/documents` (multipart `kind`, `file`, `iban`). The type is detected from content (PDF, JPEG, PNG, WebP, HEIC/AVIF); images are re-encoded to WebP (metadata dropped). Max 8 MB. A new upload supersedes the previous document of the same kind. Not allowed while `pending` or once `verified`.
- Files are **private**: stored under `tenants/{id}/verification/…` in object storage, metadata in `verification_documents` (tenant RLS). They are served only by `GET /api/v1/t/{slug}/marketplace/verification/documents/{id}` (owner) and `GET /api/v1/platform/marketplace/documents/{id}` (reviewers, MFA-guarded, **audited per view**), always `Cache-Control: private, no-store`, `nosniff`, sandbox CSP, PDFs as attachments. They are not rows in `assets`, so `/api/v1/media` never serves them.
- The business sees the IBAN masked (`SA03 •••• 7519`); reviewers see it in full.
- Submit: `POST …/verification/submit` (all required kinds present) → `pending`. LUMA: `GET /api/v1/platform/marketplace/verifications`, `GET …/verifications/{tenantId}`, `POST …/verifications/{tenantId}/review` `{decision, reason}` → `verified` (badge) or `rejected` (reason; the business re-uploads and resubmits).
- The **verified badge** shows on marketplace cards and on the published storefront («نشاط موثّق من لوما», `src/ui/storefront/VerifiedStrip.tsx`).

### Defence in depth

`app.guard_marketplace_decisions()` (trigger on `marketplace_listings` and `tenant_verifications`) rejects, outside system scope, any status other than `draft`/`pending`, any change of `commission_bp`, `approved_at`, `verified_at` or `reviewed_by`. A business cannot approve or verify itself even with a bug in tenant code. `marketplace_settings` is readable by everyone and writable only in system scope (RLS).

## 5. Favourites and «استكشفي»

- `customer_favorites (user_id, business_id)` — central customer data (column is `business_id`, not `tenant_id`, so tenant RLS does not apply; every query filters by the session user).
- `POST /api/v1/account/favorites {slug}` (listed businesses only, idempotent), `DELETE /api/v1/account/favorites/{slug}`, `GET /api/v1/account/favorites`, `GET /api/v1/account/explore`. Login required (401 otherwise); the heart on public cards sends visitors to sign in.
- Favourites show only businesses that are listed right now (a hidden business reappears when shown again).
- «مقترحة لكِ»: listed businesses not in favourites, those in the cities of her favourites (or `?city=`) first, then by rating and review count; max 8, each with a reason (`same_city` / `top_rated`).

## 6. Marketplace attribution

1. Cards link to `/s/{slug}?via=luma_market`.
2. `MarketAttribution` (storefront layout) sees the marker, posts `POST /api/v1/s/{slug}/market-visit` with header `x-luma-session` = the pseudonymous analytics session (sessionStorage, rotates after 30 idle minutes or when the tab closes — the same session that links conversions), then removes the marker from the address bar. The server records `marketplace_visits (tenant_id, session_id)` **only if the business is listed** (re-arrival refreshes the time).
3. `POST /api/v1/s/{slug}/bookings` already forwards `x-luma-session` (`ui/api.ts`). After a successful hold, `attributeMarketplaceBooking` tags the booking when that session has a marketplace visit to this business within **24 hours** and the business is still listed: `bookings.channel = 'marketplace'`, `marketplace_fee_bp` = the business's rate (or the platform default) **snapshotted at booking time**, and `attribution = {source: 'marketplace', marketplace_visit_at, commission_bp}`.
4. Everything else is `channel = 'direct'` (default): dashboard, walk-in, direct storefront visits, other sessions. `bookings.source` is unchanged (`storefront`), so analytics keep working. A CHECK ties `channel = 'marketplace'` ⇔ `marketplace_fee_bp is not null`.

Known limits: the marker is client-side, as with all web attribution (a visitor could fabricate a visit for a listed business; the effect is a commission charged to that business, visible line by line in its Finance tab). A visitor who changes device or tab, or is idle for 30 minutes, starts a new session and is no longer attributed.

## 7. LUMA commission

- Applies **only** to `channel = 'marketplace'` bookings.
- Rate: per business (`marketplace_listings.commission_bp`, set by the platform owner on the business drawer, `PUT /api/v1/platform/marketplace/tenants/{id}/commission`, step-up, audited) or, when `NULL`, the platform default (`marketplace_settings.default_commission_bp`, **10 %**, `PUT /api/v1/platform/marketplace/settings`, step-up). Changes apply to new bookings only.
- Payment data for the split-payment model: every booking payment carries `payments.platform_fee_minor` and the generated `payments.provider_net_minor = amount_minor − platform_fee_minor`. A `before insert` trigger (`app.payment_platform_fee`) fills the fee for online methods of marketplace bookings, half-up on the snapshotted rate; cash, POS and gift-card payments carry 0 (they never pass the intermediary). A split-capable provider adapter can pass these two amounts to the provider; the sandbox ignores them.
- Ledger: when a marketplace booking **completes** (booking-completed hook, same transaction), exactly one row is written to `marketplace_commissions` (`unique (tenant_id, booking_id)`, append-only): `base_minor = total − refunded` at completion, `rate_bp` (snapshot), `fee_minor` (half-up, ≤ base), `settlement = 'simulated'` unless a non-sandbox provider captured a payment carrying the fee (`pending`). With the sandbox every line is simulated: no money moves.
- Visible to the business in Finance → «عمولة سوق لوما» (`GET /api/v1/t/{slug}/finance/marketplace-fees?from&to`, `finance.view`) and to LUMA in `/platform/marketplace` → Commission (`GET /api/v1/platform/marketplace/fees?from&to`, UTC days) and in the business drawer.
- Not done here: refunds after completion do not reverse a line; the commission is not posted to the business's double-entry journal; provider payouts are owned by the payouts workstream (see below).

### `marketplaceFeesFor(tenantId, period)` — contract for payouts

```ts
import { marketplaceFeesFor } from '@/server/domains/marketplace/attribution';

marketplaceFeesFor(tenantId: string, period: { from: 'YYYY-MM-DD'; to: 'YYYY-MM-DD' }): Promise<{
  tenant_id: string; currency: string; from: string; to: string;
  bookings: number;              // commission lines in the period
  base_minor: number;            // Σ booking value (total − refunded at completion)
  fee_minor: number;             // Σ LUMA commission
  simulated_fee_minor: number;   // part recorded as simulation (sandbox / on-site)
  pending_fee_minor: number;     // part taken through a split-capable provider, awaiting settlement
  lines: Array<{ id; booking_id; booking_number; base_minor; rate_bp; fee_minor; settlement: 'simulated' | 'pending'; created_at: Date }>;
}>
```

- Period: inclusive calendar days in the **business's timezone**, by the line's `created_at` (= completion time). 422 `invalid_period` when `to < from` or a date is invalid.
- Runs in the business's tenant scope (RLS), so it is safe to call from tenant or platform code; it never mixes businesses. Amounts are integer minor units; `fee_minor` of a payout = amount owed to LUMA for the period.

## 8. Capabilities

| Capability | Roles | Used for |
|---|---|---|
| `business.manage` (tenant, owner-only) | owner | listing request, visibility, card, verification documents |
| `finance.view` (tenant) | owner, finance, delegated manager | «عمولة سوق لوما» |
| `platform.marketplace.review` | platform_owner, support_admin | queues, decisions, documents, ledger, reading settings |
| `platform.marketplace.manage` | platform_owner | per-business commission rate, marketplace settings (both with step-up) |
| `platform.tenants.view` | all platform roles | marketplace card in the business drawer |

## 9. Data model (0620)

| Table / column | Notes |
|---|---|
| `marketplace_settings` | singleton (`id = true`): `require_verification` (default true), `default_commission_bp` (default 1000). Defaults apply if the row is missing |
| `marketplace_listings` | PK `tenant_id`; `status draft/pending/approved/rejected`, `hidden`, `tagline_ar/en`, `cover_asset_id`, `commission_bp` (NULL = default), request/review columns; CHECK rejected ⇒ reason; tenant RLS + decision guard |
| `tenant_verifications` | PK `tenant_id`; `status draft/pending/verified/rejected`, submission/review columns; CHECK rejected ⇒ reason; tenant RLS + decision guard |
| `verification_documents` | private files; `kind`, `mime in (application/pdf, image/webp)`, ≤ 8 MB, `sha256`, `iban` only for `kind = 'iban'`; one current document per kind (partial unique) |
| `customer_favorites` | PK `(user_id, business_id)`, central |
| `marketplace_visits` | PK `(tenant_id, session_id)`, tenant RLS |
| `bookings.channel`, `bookings.marketplace_fee_bp` | `direct`/`marketplace`; CHECK channel ⇔ rate |
| `payments.platform_fee_minor`, `payments.provider_net_minor` | fee ≤ amount; net is generated |
| `marketplace_commissions` | append-only ledger, `unique (tenant_id, booking_id)`, tenant RLS |
| `app.marketplace_directory()` | security definer, allowlisted columns, listing rule |

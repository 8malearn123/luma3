# Business dashboard batch (phase 2)

Overview dashboard, ZATCA phase-1 simplified tax invoice, store QR, branch switcher, low-stock alerts, image crop editor, manual service badges and the weekly owner digest. Decisions: `docs/DECISIONS_2026-11.md`. Migration: `db/migrations/0650_business_dashboard.sql`.

## 1. Overview (`/app/{slug}`)

- Page: `src/app/app/[tenantSlug]/page.tsx` (server: title, trial line, readiness checklist for businesses that are not ready, quick links) + `src/ui/business/BusinessOverview.tsx` (client, refetches every 2 min and when the branch changes).
- API: `GET /api/v1/t/{slug}/overview` → `businessOverview()` in `src/server/domains/business/overview.ts`. Any member may call it; every section is gated inside the service and returned as `null` when not permitted (never as zero):

| Section | Needs |
|---|---|
| Bookings today, by status, next appointments, 7-day bookings chart | `bookings.view_all`/`bookings.manage` (everyone), or own staff profile with `bookings.view_assigned` (only her bookings) |
| Expected revenue today, booking totals, 7-day sales chart, earnings | `bookings.view_financial` or `finance.view` |
| Staff on duty / team today | `bookings.view_all`, `bookings.manage`, `schedule.manage`, `staff.edit` or `team.manage` |
| Occupancy (chair occupancy for salons) | `analytics.view`, `bookings.view_all` or `schedule.manage` |
| Latest reviews (first name only) | `customers.view` |
| Plan usage nudge (≥ 80 % of a limit) | `subscription.view` or `business.manage` |

Definitions: *bookings today* = bookings starting today (business time zone) in pending/confirmed/checked-in/in-service/completed/no-show; *expected revenue* = sum of `total_minor` of those except no-show; *sales* = captured payments by capture day (bookings + product orders); *staff on duty* = staff with available minutes today (working hours − overrides − breaks − leave − blocks, same engine as analytics occupancy); *occupancy* = booked ÷ available minutes today.

**Independent experts** (`business_type = 'expert'`): personal greeting, my appointments today, my earnings this month (completed service lines on my staff profile), profile completion checklist (photo, bio, title, logo, services, hours, contact, booking policy, published store, each linking to where it is fixed), latest reviews, and the same charts scoped to me. Labels/nav for experts are owned by another work stream.

## 2. ZATCA simplified tax invoice — phase 1 only

- `src/server/domains/finance/zatca.ts`: TLV tags 1 seller name, 2 VAT number, 3 timestamp (ISO 8601, UTC, no ms), 4 total with VAT, 5 VAT total → tag byte + UTF-8 length byte + value, concatenated, Base64. Fields are bounded to 255 bytes without splitting characters. Verified against the published example vector (`tests/unit/zatca.test.ts`).
- `src/shared/qr.ts`: dependency-free QR encoder (byte mode, versions 1–40, ECC L/M/Q/H, mask scoring). Verified module-for-module against the Python `qrcode` reference for 20 inputs across versions 1–34 during development.
- `invoiceHtml()` (`finance/documents.ts`): when the **seller snapshot at issue time** has a VAT number, receipts and invoices are titled «فاتورة ضريبية مبسطة» and embed the QR as inline SVG (works in print view and the offline PDF renderer). Without a VAT number: no QR, normal title, and the footer says so. The footer never claims phase-2 (integration/Fatoora) compliance.
- Owner warning: `ZatcaNotice` (`GET /api/v1/t/{slug}/finance/zatca`) on the Finance page and the Legal & tax settings tab.

## 3. Store link QR

`src/ui/business/StoreQr.tsx` — QR of `{origin}/s/{slug}` with the business logo on a white plate in the centre (ECC H), download PNG (1024 px canvas) and SVG (logo embedded as data URL), copy link, share on WhatsApp (`https://wa.me/?text=…`) and the device share sheet where available. Shown on the overview (for live stores, or to owners/builders before going live) and as a «رمز QR» button in the storefront builder toolbar.

## 4. Branch switcher

- Header control `src/ui/business/BranchSwitcher.tsx`: one branch or «كل الفروع». Stored per user and business in the cookie `luma_branch_{slug}`; on change all queries are invalidated and the route refreshed.
- Server: `src/server/domains/business/branch-scope.ts`. `branchScopeFor(req, access)` resolves `?branch_id=` (`all` or a branch id) first, then the cookie. Applied to: bookings list, staff list (by branch assignment), inventory items (+ low-stock count), analytics occupancy and team, overview, and the finance report (adds a `branch` slice: booking value, collections of bookings/orders in the branch, branch expenses, discounts — the ledger itself is business-wide and stays so).
- **Restriction:** a member other than the owner whose staff profile is assigned to branches sees only those branches. An explicit foreign `branch_id` → 403 `branch_not_allowed`; a foreign or stale cookie silently falls back to her branches. The owner, LUMA support and members without branch assignments are unrestricted. `GET /branch-scope` lists the branches the switcher offers.
- Not branch-filtered (no branch data): storefront analytics events, the journal-based finance figures, booking detail pages (list-level restriction only).

## 5. Low-stock alerts

`syncLowStockAlert()` in `commerce/stock.ts` runs on every stock movement. When available (on hand − reserved) ≤ the item's minimum and no alert is outstanding, it atomically sets `inventory_items.low_stock_alerted_at` and notifies (in-app) the owner and every member with `inventory.manage`. Further movements while still low do not alert. When stock rises above the minimum (restock) the marker is cleared, so the next crossing alerts again (dedupe key includes the alert time).

## 6. Image crop editor

- `src/ui/business/CropEditor.tsx`: drag / touch to pan, wheel / slider / buttons / keyboard to zoom and move, frame shapes per purpose (logo 1:1 round preview; cover 3:1, 16:9, 4:3; service 4:3, 1:1, 16:9; product 1:1, 4:3, 3:4; staff 1:1, 3:4). «رفع بدون قص» uploads unchanged. Wired into `ImageUpload` (onboarding logo/cover, services, products, staff) and the builder `ImagePicker` (logo, cover, blocks), with «قص الصورة» to re-crop an existing image.
- Server: the upload accepts an optional `crop` JSON field `{x,y,width,height}` in source pixels after EXIF orientation; the image is oriented, cropped, then goes through the normal WebP pipeline — the stored asset **is** the cropped derivative and records `assets.crop`. `POST /assets/{id}/crop` cuts a new derived asset (`assets.source_asset_id`) and keeps the original. The builder's focal-point select remains for responsive framing of already-cropped images.

## 7. Service badges (manual)

`services.badge_kind` (`popular` «الأكثر طلباً», `new` «جديد», `offer` «عرض خاص», `custom`) with `badge_text_ar/en` (≤ 24 chars, required for custom). Set in the service drawer; shown on storefront service cards (list and cards), the service page and the booking flow (`src/shared/badges.ts`). Never computed automatically.

## 8. Weekly owner digest

- Settings tab «الملخص الأسبوعي» (`GET/PUT /settings/digest`, `business.manage`): on/off, weekday (0 = Sunday), business-local hour. Default: on, Sunday 09:00.
- Periodic task `business.weekly-digest` (every 15 min, `src/server/domains/business/jobs.ts`): on the chosen local day from the chosen hour, builds one digest per week (unique on tenant + period end) for the previous seven local days: bookings (with previous week), revenue (collections, completed value), top services, staff performance (completed, no-show, value, rating), low-stock items, the coming week by day.
- Delivery: in-app notification to the owner linking to `/app/{slug}/digest/{id}`; WhatsApp/email only when a real provider is connected (`channelStatus = connected`), recorded in `delivered_channels`.
- Pages `/app/{slug}/digest` (list, «إنشاء ملخص آخر ٧ أيام») and `/app/{slug}/digest/{id}`; API `GET/POST /digests`, `GET /digests/{id}` (`business.manage` or `analytics.view`; money stripped without financial access).

## Data model (0650)

| Change | Purpose |
|---|---|
| `services.badge_kind`, `badge_text_ar`, `badge_text_en` (+ custom-text check) | manual badges |
| `inventory_items.low_stock_alerted_at` | one alert per low period |
| `assets.crop`, `assets.source_asset_id` | crop provenance |
| `tenant_settings.digest_enabled`, `digest_weekday`, `digest_hour` | digest schedule |
| `weekly_digests` (tenant RLS, unique `(tenant_id, period_end)`) | stored digests |

## Tests

`tests/unit/zatca.test.ts`, `tests/unit/business-digest-schedule.test.ts`, `tests/integration/business-overview.test.ts`, `tests/integration/business-branches.test.ts`, `tests/integration/business-ops.test.ts` (low-stock dedupe, digest scheduling/idempotence/gating, badges on the public catalog, crop upload/re-crop, ZATCA status).

# Expert experience

The four items from docs/DECISIONS_2026-11.md («تجربة الخبيرة»):

1. A workspace for experts (`tenants.business_type = 'expert'`).
2. Event bookings with a deposit («حجوزات المناسبات»).
3. A before/after portfolio («أعمالي»).
4. An Instagram section.

Migration: `db/migrations/0660_expert_experience.sql`.

| Area | Files |
|---|---|
| Workspace profile | `src/shared/workspace-profile.ts`, `src/ui/shell/nav.ts`, `src/ui/shell/DashboardShell.tsx`, `I18nLabelMap` in `src/i18n/client.tsx` |
| Event bookings | `src/server/domains/events/{service,jobs}.ts`, `src/shared/schemas/events.ts`, `src/ui/expert/EventsPage.tsx`, `src/ui/storefront/EventViews.tsx`, `src/app/s/[slug]/events/**` |
| Portfolio | `src/server/domains/portfolio/{service,storefront}.ts`, `src/shared/schemas/portfolio.ts`, `src/ui/expert/PortfolioPage.tsx` |
| Instagram | `src/server/domains/instagram/{provider,service}.ts`, `src/ui/builder/ExpertFields.tsx` |
| Builder blocks | `before_after`, `instagram` and `event_request` in `src/shared/builder/blocks.ts`. Renderers are in `src/ui/storefront/blocks/{expert,BeforeAfterSlider}.tsx` and the editors are in `src/ui/builder/{fields.ts,Properties.tsx,ExpertFields.tsx}`. |
| i18n | `src/i18n/messages/expert.ts` (`ar` and `en` have identical keys) |
| Tests | `tests/integration/expert-workspace.test.ts`, `tests/integration/expert-events.test.ts`, `tests/integration/expert-storefront.test.ts` |

## 1. Workspace profile by business type

`WORKSPACE_PROFILES` maps a business type to two things:

- **`labels`**: an i18n key → i18n key map.
- **`hiddenNav`**: the navigation keys to hide.

Salons, beauty centers and spas have no entry, so they get the identity profile. Nothing changes for them.

- **Labels.** `DashboardShell` applies the map to nav labels through `withWorkspaceLabels()`. It also wraps the page content in `<I18nLabelMap>`, so every `t()` call inside the workspace is re-labelled: page titles, tabs, and overview links that use `nav.*` keys. Pages never check the business type themselves.
  - Expert labels: bookings «مواعيدي», customers «عميلاتي», services «خدماتي», products «منتجاتي», team «مساعداتي» (the team page stays, for assistants), builder «متجري», portfolio «أعمالي», `me` «جدولي».
  - The settings tab «الفروع» becomes «الاستوديو وساعات العمل».
- **Visibility.**
  - Experts no longer have Inventory hidden. It shows for any plan that has `feature.inventory`.
  - Group classes (`groups`) are hidden for experts through the profile. They used to be hidden with `hideFor`, which still works for other items.
  - The new **events** item (`bookings.view_all` / `bookings.manage`) and **portfolio** item (`builder.edit`) show for every business type.
- **What the map does not change.** The browser tab `<title>` of dashboard pages comes from static `metadata` and is not re-labelled. The visible page titles are.
- **Overview page.** It is owned by another work stream. Its `nav.*` links are re-labelled automatically by `I18nLabelMap`, and `workspaceLabelKey()` is there if it needs anything more.

## 2. Event bookings with a deposit

### Lifecycle

```
requested ─quote→ quoted ─accept→ pending_payment ─capture→ confirmed ─complete→ completed
requested|quoted ─decline→ declined           quoted ─(expiry)→ expired
requested|quoted|pending_payment|confirmed ─cancel→ cancelled
pending_payment ─(payment failed / window lapsed)→ quoted (or expired)
```

### Request (customer, storefront)

- Page: `/s/{slug}/events`. API: `POST /api/v1/s/{slug}/event-requests`.
- Requires a verified user and an `Idempotency-Key` header. Rate limited to 10 per hour per user.
- Fields: occasion, date, start time (in the business's local time), location (`venue` with an address, or `studio`), number of people (at most `event_settings.max_people`), up to 20 visible services, notes and an optional phone number.
- The business gets an in-app notification (`event.requested`) addressed to members with `bookings.manage`.

### Quote (business)

- Page: `/app/{slug}/events`. API: `POST …/events/{id}/quote` (`bookings.manage`).
- Inputs: price, duration, preparation/travel time before and after, deposit (percent or fixed), validity in days and a note.
- Tax comes from the business's tax settings (`computeTotals`).
- The specialist defaults to the expert herself (the caller's staff profile).
- The quote is refused with 409 `slot_unavailable` when the specialist already has an allocation, a time block or approved leave in the occupied range.
- The cancellation policy and the tax settings are copied into `policy_snapshot`. Cancellations read this snapshot, never the current settings.
- The customer is notified (`event.quoted`).
- A revised quote increments `quote_version`.

### Accept and deposit (customer)

- API: `POST …/event-requests/{id}/accept` with `{ quote_version }` and an idempotency key.
  - A stale version returns 409 `quote_changed`.
  - An expired quote returns 409 `quote_expired`.
- **Time reservation.** The expert's occupied range is reserved with a `booking_allocations` row that has `event_booking_id` set:
  - The occupied range is `[start − prep_before, end + prep_after)`.
  - The row starts as `held`, with `expires_at` 30 minutes ahead (never later than the quote expiry).
  - It is subject to the **same GiST exclusion constraints** as bookings. A clash returns 409 `slot_unavailable`.
  - The booking loader already treats confirmed allocations, and held allocations that have not expired, as busy. Normal availability and holds therefore respect the event with no extra code.
- **Payment.** `payments.createEventCheckout()` creates the deposit payment (`purpose = 'event'`, `kind = 'deposit'`) through the provider abstraction (only the sandbox is connected today). The server computes the amount.
- **The redirect is not proof of payment.** The customer page polls the server state while the event is `pending_payment`.

### Capture, failure and refunds (`paymentTargets.event`, wired in `boot.ts`)

- **Capture.** The journal posts Dr cash/clearing, Cr `customer_deposits`. The event's held allocation becomes `confirmed`, the event becomes `confirmed`, and the customer and the business are notified (`event.confirmed`).
- **Late capture.** If the hold has lapsed, the same range is re-inserted as `confirmed` if it is still free. If it was taken, the event is cancelled (system), the payment is flagged `late_success_slot_taken` and fully refunded.
- **Capture after close.** A capture on a cancelled or declined event is flagged `captured_after_event_closed` and refunded.
- **Failure or cancel webhook.** The held allocation is released and the event goes back to `quoted` (or `expired`), so the customer can accept again.
- **Refund succeeded.** `event_bookings.refunded_minor` increases, and the journal posts Dr `customer_deposits` (or `refunds` after completion), Cr cash/clearing.
- **Sweeps.** Lapsed checkouts and quotes are settled lazily on every read and by the periodic task `events.expire` (every 2 minutes).

### On the day

- **Balance.** `POST …/events/{id}/balance` (`payments.collect`, idempotency key required) records cash or terminal money with a mandatory reference. It is applied through `applyCapturedPayment`.
- **Complete.** `POST …/events/{id}/complete` (`bookings.manage`, only after the start time) recognises revenue:
  - Dr `customer_deposits` (the prepaid part).
  - Dr `accounts_receivable` (any unpaid part).
  - Cr `service_revenue` (net) and `tax_payable`.

### Cancellation (`eventCancellationRefund`, pure)

| Who | When | Result |
|---|---|---|
| Business or system | any time | Everything paid is refunded |
| Customer | ≥ `free_cancellation_days` before the event (from the snapshot) | Full refund |
| Customer | later | The deposit is retained (posted Dr `customer_deposits` / Cr `service_revenue`, ref `event_retained`). Anything paid above the deposit is refunded. |

- Refunds are system-approved and sent through the provider (`refundEventDue`). They count as refunded only once the provider confirms.
- Cancelling releases the allocation, so the time becomes bookable again.
- Customers cannot cancel after the event has started.
- The other party is notified (`event.cancelled`).

### Settings (`event_settings`, `PUT /api/v1/t/{slug}/event-settings`, `business.manage`)

| Setting | Default |
|---|---|
| Accept requests | on |
| Default deposit | 30% |
| Free cancellation | 7 days |
| Quote validity | 3 days |
| Maximum people per request | 30 |
| Intro text (ar/en) | — |

Event bookings work for salons as well as experts.

## 3. Before/after portfolio

- **Table `portfolio_items`.**
  - `after_asset_id` is required and `before_asset_id` is optional (a single image).
  - Other fields: caption ar/en, a free-text category, an optional service, `is_visible` and `sort`.
  - Only this tenant's **public, ready** images are accepted.
  - Managed at `/app/{slug}/portfolio` («أعمالي» for experts, «معرض الأعمال» otherwise). API: `/api/v1/t/{slug}/portfolio` (`builder.edit`).
- **Block `before_after`** (media, page only, at most 4 per page, strict schema):
  - `source`: `items` (up to 30 hand-picked pairs, each `{before_asset_id, after_asset_id, caption?, category?}`, and before ≠ after) or `portfolio` (visible portfolio pairs, with an optional `category` filter).
  - Display props: `columns` 1–3, `limit` 1–60, `start` 10–90 (the divider's starting position) and `show_labels`.
  - Pair images take part in the builder's reference checks (`collectReferences`), so private or foreign images are refused when saving. They also take part in the storefront asset allowlist.
- **Rendering.** `BeforeAfterSlider` stacks the two images and clips the "before" image to the start side (it follows RTL).
  - The divider is a native `<input type="range">` with a label, so it works from the keyboard (arrows, Home/End, PageUp/PageDown).
  - `aria-valuetext` reads "{n}% of the before image shown", and focus is visible.
  - Each image has its own alt text.
  - `beforeAfterItems()` produces the public view model (pure, and tested).
- **Storefront data.** `loadStorefrontExtras()` adds `portfolio`, `instagram` and `events` to `StorefrontData` (optional fields). Portfolio and Instagram data are loaded only when a page uses the block, or always in the builder canvas.

## 4. Instagram section

- **Official API only, never scraping.** `InstagramProvider` (`fetchAccount`, `fetchRecentMedia`) is implemented by `graphProvider` against `graph.instagram.com` (Instagram API with Instagram Login).
  - It is "configured" only when `INSTAGRAM_APP_ID` and `INSTAGRAM_APP_SECRET` are set. **No Meta credentials exist today.**
  - Until then, `POST /api/v1/t/{slug}/instagram/connect` returns 503 `instagram_not_configured` and stores nothing.
- **Table `instagram_connections`.**
  - `handle`. The profile link uses it, and falls back to `tenant_settings.social_links.instagram`.
  - `status`.
  - `ig_user_id`.
  - `access_token_enc`: encrypted with the platform secret helper (AES-256-GCM). It is never returned.
  - `posts`: a cached JSON array, at most 24 entries.
  - The sync (`syncInstagram`, connect, `POST …/instagram/sync`, and the periodic task `instagram.sync` every 6 hours) keeps only posts with an `instagram.com` permalink and a media URL on an Instagram CDN. A failed sync keeps the old posts and sets `status = 'error'`.
- **Block `instagram`** (info, at most 1 per page): `title`, `limit` 3–12, `columns` 2–4, `show_follow`, `follow_text`. `instagramView()` decides what to show:
  - **posts**: an account is connected and has cached posts. Images are served through `GET /api/v1/s/{slug}/instagram/{postId}`, a same-origin proxy that fetches only cached posts from Instagram media hosts (image types, at most 5 MB). Visitors' browsers never contact Meta and the CSP stays `img-src 'self'`.
  - **follow**: the styled «تابعينا على إنستقرام» card linking to `https://www.instagram.com/{handle}/`.
  - **none**: there is no handle, so nothing is shown publicly (a placeholder appears in the builder).
- **Builder.** The block's properties panel shows the account card: handle, connection status, and a note that connecting is coming soon. The handle is saved with `PUT /api/v1/t/{slug}/instagram` (`builder.edit` or `business.manage`).

## 5. Shared files touched (additive)

- `src/ui/shell/nav.ts`: two items (events, portfolio). Inventory is no longer hidden for experts, and the profile `hiddenNav` is honoured.
- `src/ui/shell/DashboardShell.tsx` and `src/ui/shell/icons.tsx`: the label map, and two icons.
- `src/i18n/client.tsx` (`I18nLabelMap`) and `src/i18n/index.ts`: registers `expert`.
- `src/shared/builder/blocks.ts` (three block types, and pair assets in `collectReferences`), `src/shared/builder/storefront.ts` (optional `portfolio`, `instagram` and `events`), `src/ui/storefront/BlockRenderer.tsx`, `src/ui/builder/{fields.ts,Properties.tsx,Library.tsx}`.
- `src/server/domains/storefront/service.ts`: extras and pair assets.
- `src/server/domains/payments/{service,targets}.ts`: the `event` purpose, `createEventCheckout`, `refundEventDue`, and the capture, failure and refund branches.
- `src/server/domains/booking/service.ts`: `releaseExpiredHolds` is now exported.
- `src/server/boot.ts`, `src/server/jobs/index.ts`, `src/server/env.ts`, `.env.example`.
- `src/server/db/schema.generated.ts`: regenerated.

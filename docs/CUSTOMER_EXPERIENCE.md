# Customer experience (phase 2)

Implements the customer-facing decisions in [DECISIONS_2026-11.md](DECISIONS_2026-11.md): coupons and branch choice on the booking page, rebook, loyalty in `/account`, review requests after the visit, online gift cards and memberships, the acquisition question, the root 404, «تذكريني», and the smart back arrow.

Migration: `db/migrations/0640_customer_experience.sql`. Messages: `src/i18n/messages/customer.ts` (`customer.*`, plus a few `errors.*`).

| # | Feature | Server | Routes | UI | Tests |
|---|---|---|---|---|---|
| 1 | Coupon on the booking page (scope) | `booking/service.ts` `createHold`, `booking/coupon-preview.ts`, `commerce/coupons.ts`, `boot.ts` | `POST /api/v1/s/{slug}/bookings` (`coupon_code`), `POST /api/v1/s/{slug}/bookings/coupon`, `PATCH /api/v1/t/{slug}/coupons/{id}` (`applies_to`) | `ui/booking/BookingFlow.tsx`, `ui/commerce/CouponsTab.tsx` | `customer-booking-page.test.ts` |
| 1 | Branch picker | `booking/loader.ts` (unchanged rules) | availability/hold take `branch_id` | `app/s/[slug]/booking/page.tsx`, `BookingFlow.tsx` | `customer-booking-page.test.ts` |
| 2 | Rebook | `booking/rebook.ts` | `GET /api/v1/account/bookings/{id}/rebook`; page `/s/{slug}/booking?rebook={id}` | `ui/account/ActivityPanels.tsx`, `ui/account/BookingDetail.tsx` | `customer-account.test.ts` |
| 3 | Loyalty in `/account` | `loyalty/account.ts` | `GET /api/v1/account/loyalty`; page `/account/loyalty` | `ui/account/LoyaltyPanel.tsx`, `AccountNav.tsx` | `customer-account.test.ts` |
| 4 | Review request after the visit | `reviews/requests.ts`, `reviews/jobs.ts` | `GET/PUT /api/v1/t/{slug}/settings/review-requests` | `ui/settings/ReviewRequests.tsx` (Settings → Notifications) | `customer-review-requests.test.ts` |
| 5 | Online gift cards + direct send | `giftcards/online.ts`, `giftcards/jobs.ts`, `payments/service.ts` `createStoredValueCheckout`, `boot.ts` | `POST /api/v1/s/{slug}/gift-cards/purchase`, `GET …/gift-cards/purchases/{id}`; pages `/s/{slug}/gift-cards`, `/s/{slug}/gift-cards/purchase/{id}`, `/s/{slug}/gift/{token}` | `ui/storefront/OnlinePurchase.tsx` | `customer-online-purchase.test.ts` |
| 5 | Online memberships | `memberships/online.ts`, `boot.ts` | `POST /api/v1/s/{slug}/memberships/purchase`, `GET …/memberships/purchases/{id}`; page `/s/{slug}/memberships/purchase/{id}` | `MembershipStore` on `/s/{slug}/memberships` | `customer-online-purchase.test.ts` |
| 6 | «كيف عرفتِ عنا؟» | `customers/acquisition.ts`, `shared/acquisition.ts` | `GET/POST /api/v1/s/{slug}/acquisition`, `GET /api/v1/t/{slug}/analytics/acquisition`, customers list `?acquisition=` | `AcquisitionQuestion` (checkout & purchase pages), `RegisterForm`, customers list column/filter, `ui/analytics/AcquisitionCard.tsx` | `customer-acquisition.test.ts` |
| 7 | Root 404 | — | — | `app/not-found.tsx` | — (rendering only) |
| 8 | «تذكريني» | `auth/service.ts`, `http/route.ts` `sessionCookie` | `POST /api/v1/auth/login` (`remember`) | `ui/auth/LoginForm.tsx` | `customer-remember-me.test.ts` |
| 9 | Smart back arrow | — | — | `ui/storefront/BackArrow.tsx` in `StorefrontShell` | `customer-booking-page.test.ts` |

## 1. Booking page

**Coupon scope.** Coupons already carried `applies_to` (`services` / `products` / `all`). The owner chooses it when creating a coupon and can now change it inline in the coupons table (`PATCH … { applies_to }`; loyalty-reward coupons keep their scope). Bookings accept `services` and `all`; orders accept `products` and `all` (`coupon_not_applicable` otherwise).

**Discount before the deposit.** `createHold` validates the code inside the hold transaction (`validateCoupon`, scope `services`), computes `computeTotals(subtotal, discount, …)` and only then computes the payment terms, so a percent deposit is a percentage of the discounted total. The booking stores `coupon_id`; `redeemCoupon` locks the coupon row and re-checks the global and per-customer limits. The code is part of the hold's idempotency hash. When the hold expires or the booking is cancelled, the `released` booking hook calls `releaseCouponRedemption` (exactly once); a no-show keeps it. Rescheduling keeps the booking's discount (unchanged behaviour).

`POST /api/v1/s/{slug}/bookings/coupon` previews a code against the chosen itinerary (service × specialist priced on the server) and returns discount, total and deposit. Nothing is redeemed. The booking page applies it in step 3 and shows the new total and the deposit after the discount.

**Branch picker.** Shown only when the business has more than one active branch. Services tied to another branch and specialists not assigned to the chosen branch are hidden (`servicesAtBranch`); availability and the hold send `branch_id`. The engine and `resolveItems` already enforce the branch (`service_not_at_branch`, staff assignment, branch hours and timezone).

## 2. Rebook

`rebookPrefill(user, bookingId)` (own booking only, via `app.customer_booking_ref`) returns the current items with the same services and specialists, keeping only what is still publicly bookable at that branch: a hidden/archived service is marked `unavailable`, a specialist who no longer offers it there becomes "any specialist". «احجزي مرة ثانية» on `/account/bookings` and the booking detail opens `/s/{slug}/booking?rebook={id}`; the page prefills services, specialists and branch, and the customer picks the new time (normal availability, hold and payment rules).

## 3. Loyalty in `/account`

`/account/loyalty` («نقاطي») lists every active business she deals with that runs a loyalty programme (or where she still holds points): balance, tier (highest `min_lifetime_points` reached), progress and points to the next tier, earn rate, inactivity expiry date, and that business's rewards (redeemable or not). Each business is read inside its own tenant scope.

## 4. Review request after the visit

Owner setting (Settings → Notifications): `review_request_mode` = `off` | `immediately` | `after_hours` (`review_request_delay_hours`, 1–168, default 3), plus an optional single reminder `review_reminder_hours` (1–336) after the first request. Default for existing businesses: after 3 hours, no reminder. Versioned with the other settings (`409 version_conflict`).

Job `reviews.request-after-visit` (every 5 minutes, `sendReviewRequests(now)`): completion time = the `booking_events` row that moved the booking to `completed`. For completed visits with a customer account, no review and no request yet, completed within the last 30 days and past the configured delay, it inserts `review_requests` (unique per booking → exactly once), sends an in-app notification linking to `/account/reviews`, and enqueues outbox topic `review.request`. Reminders (`review.reminder`) are sent once, only while no review exists. The outbox handler delivers the message on the business's enabled channels (WhatsApp/SMS/email) through `sendTransactional` — simulated in development, recorded as failed/no provider otherwise, delivered for real once a provider is connected. Requests answered by a review are marked `reviewed`.

## 5. Online gift cards and memberships

Both use the existing provider abstraction: `createStoredValueCheckout` (payments service) creates the `payments` row (`purpose` `gift_card` / `membership`) and the hosted checkout (sandbox in dev). Nothing is confirmed by the redirect; the verified webhook → `applyCaptured` → `paymentTargets.giftCard.onCaptured` / `.membership.onCaptured` (now wired in `boot.ts`), and the journal posts Dr cash/clearing, Cr `gift_card_liability` / `membership_liability`. Purchase endpoints require a verified account and an `Idempotency-Key`, and are gated by `feature.gift_cards` / `feature.memberships`.

**Gift cards.** `purchaseGiftCard` creates a `pending` card (balance 0, code hash + last 4) and a `gift_card_deliveries` row (`awaiting_payment`) with the recipient's name, mobile and/or email, message and `send_at` (now if omitted; up to a year ahead). On capture the card is activated once (ledger `issue` entry, valid 365 days) and the delivery becomes `scheduled`. Job `giftcards.deliver-scheduled` (every minute, `deliverDueGiftCards(now)`) sends due deliveries: mobile → WhatsApp when connected (or preferred by the business), otherwise SMS; email → email. The message contains the code and a private link `/s/{slug}/gift/{token}` (random token, only its HMAC is stored). Status is recorded honestly: `sent` (a provider accepted it), `simulated` (dev outbox), or retried with exponential backoff and `failed` after 5 attempts when no provider is connected (the buyer is notified). Statuses never claim a send that did not happen.

Code at rest: the card still stores only the keyed hash and last 4 characters; to send at a later time and show the code on the recipient page, the delivery keeps the code encrypted (AES-256-GCM, key derived from `AUTH_SECRET`, HKDF info `gift-code-encryption`). The buyer never sees the code (only the last 4).

**Memberships.** `purchaseMembership` creates a `pending_payment` membership with the plan snapshot; capture activates it once (`activateMembership`: entitlements and validity from the snapshot) and notifies her. Free plans are activated immediately. A failed payment leaves it pending (she can buy again). `/s/{slug}/memberships` now has a buy button per plan and a link to gift cards.

## 6. Acquisition source («كيف عرفتِ عنا؟»)

Stored per business relationship on `tenant_customers` (`acquisition_source`, `acquisition_method` `inferred`/`asked`, `acquisition_detail`, `acquisition_at`), first touch:

1. After a booking hold or an online purchase, the route calls `recordAcquisition` with the storefront analytics session (`x-luma-session`). The first event of that session that carries a referrer or UTM is classified (`classifyAttribution`): `utm_medium=referral` → **referral**; `utm_medium=marketplace` / `utm_source=luma_marketplace` → **marketplace** (Souq LUMA links); any `utm_campaign` → **campaign**; Instagram / TikTok / Snapchat / Google / X / WhatsApp by UTM source or referrer domain; any other referrer → **website**; a session without either → **direct**.
2. If nothing was inferred (no session) or only `direct`, the optional answer given at registration (`customer_profiles.heard_from`) is used once.
3. Otherwise the checkout and purchase pages ask the optional question (`GET/POST /api/v1/s/{slug}/acquisition`). Her answer replaces only an unknown or `direct` value; a specific inferred source is never overwritten, and later visits never re-attribute her.

Shown in the customers list (column and filter `?acquisition=…`, including `unknown`) and in Analytics → Store («كيف عرفت العميلات عنا»: new customers in the period by source, share, how many visited, how many answered).

## 7. Root 404

`src/app/not-found.tsx`: LUMA plum identity, logo, Arabic-first copy, links home and to «حجوزاتي». The storefront keeps its own themed `s/[slug]/not-found.tsx`.

## 8. «تذكريني»

`POST /api/v1/auth/login { remember }` (default `false`).

| | Cookie | Server `expires_at` | Idle timeout |
|---|---|---|---|
| Checked | `Expires` = 30 days | 30 days | 7 days (sliding) |
| Unchecked | browser-session cookie (no `Expires`/`Max-Age`) | 24 hours | 12 hours (sliding) |

`sessions.persistent` stores the choice. Security properties are unchanged: every sign-in creates a new session and random token (rotation), the cookie stays `HttpOnly`, `SameSite=Lax`, `Secure` when deployed, and logout, "sign out other sessions", password change/reset revoke both kinds. The server-side cap means a browser that restores session cookies cannot keep an unchecked session alive beyond 24 hours. In the embedded demo database the signed cookie token carries no new field: a lifetime beyond the 24-hour cap is read as persistent. Registration (verify step), demo sign-in and platform MFA keep their existing 30-day sessions.

## 9. Smart back arrow

`BackArrow` sits at the start of the storefront header on every page except the home page (also the booking and checkout pages), not in the builder canvas or previews. It goes back in history only when the previous entry is on this site (`navigation.canGoBack`, whose entries are same-origin only; fallback: `history.length > 1` and a same-origin `document.referrer`), otherwise it navigates to the storefront home — so a customer arriving from Instagram or a shared link never leaves the site.

## Known limits

- Order checkout does not yet record the acquisition source (only bookings and online gift card / membership purchases do); the order route is owned by commerce.
- There are no referral or marketplace links in the code yet; the classifier recognises the UTM conventions above so those features only need to tag their links.
- Gift deliveries cannot be rescheduled or cancelled by the buyer after payment, and the "no provider → retry → failed" path is exercised in production only (tests run with the development outbox).
- Coupons are not applied to dashboard (staff) bookings; the field is ignored there.

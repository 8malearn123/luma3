# Booking engine

| File | Role |
|---|---|
| `src/server/domains/booking/engine.ts` | **Pure** availability algorithm (no I/O; deterministic, unit-tested) |
| `src/server/domains/booking/loader.ts` | Validates requested services and loads schedules and allocations into `EngineInput` |
| `src/server/domains/booking/service.ts` | Search, holds, confirmation, transitions, rescheduling, hold-expiry sweeper |
| `src/server/domains/booking/transitions.ts` | The lifecycle table (the only way a booking changes state) |
| `src/server/domains/booking/pricing.ts` | Totals and tax rule; cancellation refund |
| `src/server/domains/booking/hooks.ts` and `src/server/boot.ts` | Cross-domain side effects |
| `src/server/domains/booking/jobs.ts` | `booking.expire-holds` sweeper (every 30 s) |

## 1. Resolving the request (`resolveItems`)

A request has 1–6 items `{ key, serviceId, variantId?, addonIds?, staffId? }` with unique keys. For each item:

- The service must exist and not be archived. It must be `is_active`, otherwise `service_inactive`.
- Audience `public`: the service is unavailable if it is hidden, or if its category is hidden or archived. Audience `internal` (dashboard): hidden services are bookable only when `bookable_internally_when_hidden`.
- `booking_mode` must be `individual`. Group services are booked through group sessions.
- If the service is tied to a branch, it must be the requested branch.
- Variants and add-ons must belong to the service and be active. Duplicate add-ons are rejected.
- **Qualified staff** = `service_staff` links where the staff member is active, not archived and assigned to the branch (`staff_branch_assignments`), and `is_public` for public requests. A requested `staffId` narrows the set. An empty set returns `no_qualified_staff` or `staff_not_qualified`.
- **Price and duration per staff member**: a variant wins over the per-specialist override, which wins over the base service. Add-on prices and durations are added on top.
- Buffers come from the service (`buffer_before_min`, `buffer_after_min`). Resource needs come from `service_resource_requirements`.

## 2. Loading the schedule snapshot (`loadEngineInput`)

For the branch timezone and the local date range (padded ±12 h), the loader collects:

| Input | Source |
|---|---|
| Weekly hours | `working_hours` for the branch (several ranges per weekday; `effective_from` / `effective_to`) |
| Breaks | `staff_breaks` (recurring weekday or dated) |
| Overrides | `shift_overrides` (`off`, `replace`, `extra`) |
| Busy instants | approved `leave_requests`, `time_blocks` (staff or resource), and **active allocations**: `confirmed`, or `held` with `expires_at > now`. Expired holds do not count as busy. |
| Branch hours | `branch_hours`. When defined, they are intersected with working hours. |
| Resources | active resources of the needed types in the branch, with their busy ranges |
| Booked minutes per staff per local date | for the "least booked" tie-break |
| Policy | `slot_increment_min`, `max_gap_between_items_min`, `any_staff_rule`; notice = **max**(tenant `min_notice_min`, each service's `min_notice_min`); window = **min**(tenant `max_advance_days`, each service's `max_advance_days`) |

## 3. Availability algorithm (`engine.ts`)

All ranges are half-open `[start, end)` in epoch milliseconds. Local wall-clock times are converted with Luxon in the **branch timezone**, so DST and UTC offsets are handled per date.

1. **Working windows** for one staff member on one local date:
   - If an `off` override exists for the date: no windows.
   - Else if `replace` overrides exist: only those ranges.
   - Else: the weekly ranges for that weekday within their effective dates.
   - Add `extra` override ranges (unless the day is off), then merge.
   - Intersect with branch opening hours when any are defined.
   - Subtract breaks (dated breaks on their date, recurring breaks on their weekday).
2. **Free windows** = working windows − busy instants (leave, blocks, allocations).
3. **Bounds**: earliest start = `now + minNotice`; latest = end of the local day `maxAdvanceDays` after today.
4. **Candidate starts** for the first item: every time aligned to `slot_increment_min` (counted from local midnight), starting at `window.start + bufferBefore`, inside a free window of any qualified staff member, and not before the earliest bound.
5. **Placement** (`place`, depth-first per item): for each aligned start `t` and each candidate staff member in ranked order, the item occupies `[t − bufferBefore, t + duration + bufferAfter)`. The occupied range must lie entirely inside one of that staff member's free windows and must not overlap anything already placed for that staff member in this itinerary. Resource units are then picked (`pickResources`): for each required type, the first `quantity` units by id that are free over the occupied range and not already chosen.
6. **Multi-service itineraries**: item *n+1* must start within `[end of item n, end of item n + maxGap]`, aligned to the increment. Different staff per item are allowed, and so is the same staff member doing consecutive services. If any item cannot be placed, the whole itinerary is discarded; no partial sequence is returned. Each result reports `gaps_min[]` and `total_gap_min`, so gaps are disclosed to the customer.
7. **Bounds on search**: at most 200 itineraries per day and 20,000 search nodes. `itinerariesForRange` covers at most 32 days. The service-level `searchAvailability` accepts at most 14 days per request.
8. **Output** contains only feasible options: start and end, and per item the staff member, price and duration. It never shows who is booked or why a time is taken. When nothing is available, `next_available_date` is looked up over the following 30 days. For multi-item requests the response suggests separate bookings or other days.

### "Any available" staff rule

`rankStaff()` is deterministic and never random. The rule is chosen per business (`tenant_settings.any_staff_rule`):

| Rule | Ranking among staff free at the same start |
|---|---|
| `earliest_then_least_booked` (default) | fewest booked minutes that local day, then `staff_profiles.sort`, then id |
| `earliest_then_staff_order` | `staff_profiles.sort`, then id |

"Earliest" comes from iterating start times in ascending order. The first staff member in rank order who fits wins that start.

### Buffers, breaks, leave, overrides and resources

- Buffers are part of the **occupied** range that is allocated, so they block the staff member and every required resource. They do not extend the price or the displayed service time.
- Breaks and branch hours cut working windows. Leave and time blocks are subtracted as busy instants.
- A resource is a single unit (three chairs = three resources). A service needing `quantity = 2` of a type needs two distinct free units.
- `availableMinutes()` (used for occupancy analytics) is working time minus non-booking busy time.

## 4. Holds: allocations with `expires_at`

`createHold()`:

1. Runs inside `withTenant` and `idempotent(scope = tenant:actor, operation = 'booking.hold', key)`.
2. Releases **expired** holds that could block the requested staff (`releaseExpiredHolds`). Their bookings move to `expired` with an event and the `released` hook, in the same transaction.
3. Re-validates the exact itinerary with `validateItinerary()`: qualified staff, notice, window, sequence/gap, staff free, resources free. Failures return 409 `slot_unavailable` (or the specific reason: `notice_period`, `beyond_booking_window`, `invalid_sequence`, `staff_not_qualified`).
4. Resolves or creates the `tenant_customers` row for the signed-in user. Customer ids are never taken from the browser for public bookings.
5. Takes the **policy snapshot**, computes totals and **payment terms** (see [PAYMENT_FLOW.md](PAYMENT_FLOW.md)), and sets `requires_manual_approval` from the terms or the service.
6. Releases expired holds on the chosen resources.
7. Inserts the `bookings` row (`status = 'held'`, `hold_expires_at = now + hold_ttl_sec`; the default TTL is 600 s), the `booking_items` snapshots, and one `booking_allocations` row per staff member and per resource unit with `state = 'held'` and `expires_at`.
8. Writes a `booking_events` row (`kind = 'created'`) and an audit entry.

The exclusion constraints on `booking_allocations` (see [DATA_MODEL.md](DATA_MODEL.md#customers-and-bookings)) cover `held` and `confirmed` rows. Two transactions can both believe a slot is free, but only one `INSERT` succeeds. The loser gets PostgreSQL error `23P01`, which is mapped to 409 `slot_unavailable`.

## 5. Concurrency guarantees and deadlock avoidance

| Guarantee | Mechanism |
|---|---|
| No double booking of a staff member or resource unit | `EXCLUDE USING gist (tenant_id =, staff_id =, during &&)` and the same for `resource_id`, for `state in (held, confirmed)` |
| Availability results are advisory | The hold re-validates inside the allocating transaction; the constraint is final |
| No deadlock between concurrent multi-resource holds | Allocations are inserted in a **stable global order**: sorted by staff or resource id, then start time. The same order is used in reschedule and in late-payment reallocation. |
| Expired holds never block | Released lazily (same transaction, before allocating) and by the sweeper; the loader ignores them |
| Lifecycle changes are serialised | `transition`, `reschedule`, `applyHoldOutcome` and checkout lock the booking row (`SELECT … FOR UPDATE`) |
| Whole operation or nothing | Every hold, transition and reschedule is a single transaction; any failure rolls back all allocations |
| Optimistic concurrency for staff edits | `bookings.version`; `transition()` accepts `expectedVersion`, and a mismatch returns 409 `version_conflict` |

## 6. Idempotency

`src/server/infra/idempotency.ts`. The record is inserted with `ON CONFLICT DO NOTHING` in the **same transaction** as the operation:

- First request: inserts `in_progress`, runs, stores the response, commits.
- Concurrent duplicate: waits on the unique index, then replays the stored response (`replayed: true`).
- Same key with a different payload hash: 422 `idempotency_key_reused`.
- If the first attempt rolled back, there is no record and a retry proceeds normally.
- Keys must be 8–200 safe characters. Records expire after 24 h (cleaned hourly by `expire-idempotency-and-rate-limits`).

Booking endpoints that **require** `Idempotency-Key`: `POST /api/v1/s/{slug}/bookings` (hold), `POST …/bookings/{id}/checkout`, `POST …/bookings/{id}/gift-card`, `POST …/group-sessions/{id}/book`, `POST /api/v1/account/waitlist/offers/{id}/accept`, and dashboard `POST /api/v1/t/{slug}/bookings`. The client hook `useApiMutation` keeps one key per submission across retries.

## 7. Lifecycle (`transitions.ts`)

Service state (`bookings.status`) is separate from financial state (`bookings.payment_status`).

```
draft → held ─┬─→ pending_payment ─→ confirmed → checked_in → in_service → completed
              ├─→ pending_approval ─→ confirmed            ↘ no_show (after start + grace)
              └─→ confirmed (on-site / nothing due)
held / pending_payment → expired           active states → cancelled
```

Moves from `held` to `pending_payment`, `pending_approval` or `confirmed` are made by `applyHoldOutcome()`, which checkout and payment capture call. Every other move goes through the `TRANSITIONS` table:

| Action | From | To | Staff capability | Assigned specialist | Customer | System | Guards | Releases allocations |
|---|---|---|---|---|---|---|---|---|
| `approve` | pending_approval | confirmed | `bookings.manage` | — | no | no | — | no |
| `reject` | pending_approval | cancelled | `bookings.manage` | — | no | no | reason required | yes |
| `check_in` | confirmed | checked_in | `bookings.manage` | `bookings.manage_assigned` | no | no | appointment day (branch tz) | no |
| `start` | confirmed, checked_in | in_service | `bookings.manage` | `bookings.manage_assigned` | no | no | appointment day | no |
| `complete` | checked_in, in_service | completed | `bookings.manage` | `bookings.manage_assigned` | no | no | — | no |
| `no_show` | confirmed | no_show | `bookings.manage` | `bookings.manage_assigned` | no | no | **not before `starts_at + no_show_grace_min`** (from the snapshot) | yes |
| `cancel` | held, pending_approval, pending_payment, confirmed, checked_in | cancelled | `bookings.manage` | — | own booking only | yes | customer: before start; reason (3 or more characters) unless system | yes |
| `expire` | held, pending_payment | expired | — | — | no | yes | — | yes |

Side effects run in the same transaction:

- `start` sets `actual_started_at` on the first item. `complete` sets `actual_ended_at`, and `actual_started_at` where it is missing.
- `cancel` / `reject`: `cancellationRefund()` computes the refund from the **booking-time snapshot**. Business- or system-initiated cancellations refund everything paid. A customer inside `free_cancellation_hours` gets a full refund. A customer cancelling later pays a fee of `total × late_cancellation_fee_bp`, capped at the amount paid. The refund hook runs **before** the released hook, so the amount retained under the policy is what remains afterwards.
- Every transition writes an append-only `booking_events` row (actor, role, source, reason, refund data) and an audit entry.
- Notifications: confirmation, cancellation and approval create in-app notifications and enqueue outbox messages (`booking.confirmed`, `booking.cancelled`, `booking.rescheduled`, `booking.pending_approval`).

## 8. Rescheduling with rollback

`reschedule()` keeps the **same booking** (payments stay linked) and replaces its items in one transaction:

1. Lock the booking. A customer can reschedule only her own booking, and only before it starts. Staff need `bookings.manage`. Only `confirmed` or `pending_approval` bookings can be rescheduled.
2. Release the current allocations, **in the same transaction**.
3. Validate the new itinerary. If it fails, return 409 `slot_unavailable` with "your original appointment is unchanged". The transaction rolls back, so the original allocations come back untouched.
4. Recompute totals with the **original** tax snapshot. If the total changed, the caller must send `acceptTotalMinor` equal to the new total; otherwise the response is 409 `price_changed` with the old and new totals.
5. Mark the current items `superseded_at`, insert the new items with `revision + 1`, insert `confirmed` allocations in stable order, and update the booking times, totals and `payment_status`.
6. Write a `kind = 'rescheduled'` event and an audit entry. If the amount paid now exceeds the new total, a refund for the difference is triggered (`reschedule_price_decrease`). The freed slot is offered to the waitlist.

Superseded items stay in the database for history and are returned separately as `history_items`.

## 9. Policy snapshot at booking time

`policySnapshot()` copies these settings into `bookings.policy_snapshot` when the hold is created: `free_cancellation_hours`, `late_cancellation_fee_bp`, `no_show_grace_min`, `tax_rate_bp`, `prices_include_tax`, `tax_label`, `hold_ttl_sec`, the booking policy text (ar/en) and `captured_at`. Cancellation refunds, no-show timing, reschedule tax and invoice `tax_basis` all read this snapshot, **never the current settings**. Payment terms are snapshotted separately in `bookings.payment_terms`.

Totals (`computeTotals`, rounding half-up to the halala):

- Prices include tax: `total = subtotal − discount`, `tax = round(total × r / (1 + r))`.
- Prices exclude tax: `tax = round((subtotal − discount) × r)`, `total = subtotal − discount + tax`.

## 10. Hold expiry

- Lazily inside `createHold` (`releaseExpiredHolds`).
- By the periodic task `booking.expire-holds` (every 30 s): `expireStaleHolds()` finds `held` / `pending_payment` bookings past `hold_expires_at` (up to 500 per run) and expires each in its own tenant transaction. `expireBookings` only updates rows still in `held` / `pending_payment`, so expiry happens exactly once.
- A payment that succeeds after expiry is handled as a *late success*; see [PAYMENT_FLOW.md](PAYMENT_FLOW.md#late-success-after-hold-expiry).

## 11. Waitlist offers

`src/server/domains/waitlist/service.ts`, ranking policy declared in migration `0018`:

- Joining needs a verified account and a service. An entry stores a date range, optional time windows, an optional specialist and `notify_consent`.
- `offerFreedSlot()` runs on the `slotFreed` hook (customer or staff cancellation, no-show, reschedule). For each freed future item it looks for **active, consenting, unexpired** entries for that branch and date, with the same specialist or no preference. Ranking puts entries that asked for the freed specialist first, then first come first served by `created_at`. Each candidate's service is checked with the engine at that time with that specialist.
- Only **one pending offer per `(tenant, staff_id, slot_start)`** can exist (partial unique index), so one opening is never promised to several people. Offers expire after `waitlist_offer_ttl_min` (default 30). The `waitlist.expire-offers` task (every 60 s) expires them and passes the opening to the next candidate.
- Accepting (`POST /api/v1/account/waitlist/offers/{id}/accept`, idempotency key required) creates a normal **hold** through `createHold`. If the time was taken meanwhile, the hold fails with 409, the offer becomes `superseded` and the entry returns to `active`.

## 12. Group sessions

`src/server/domains/groups/service.ts`:

- Creating a session (`feature.group_sessions`, `bookings.manage`) reserves the instructor's time (and an optional resource) with **the same exclusion constraints**. The allocation row has `group_session_id` and no booking, so the instructor cannot be booked individually over a session.
- `bookSeats()` locks the session row, checks capacity and allows one active seat booking per customer. It creates a `confirmed` booking with on-site payment terms, a `group_session_bookings` row and increments `seats_taken`. `CHECK (seats_taken <= capacity)` is the final guard.
- Releasing a seat booking (cancel or no-show) decrements `seats_taken` once (status guard).
- Cancelling a session releases its allocations, then cancels each seat booking through `transition('cancel')`, so refunds follow the snapshot terms. Each seat cancellation runs in its own transaction.
- Gap: seat bookings carry `payment_terms.allowed = ['on_site']`. There is no online payment path for group seats.

## 13. Hooks wiring (`src/server/boot.ts`)

`boot.ts` is imported by the route wrapper, the webhook route, the seed and the worker. A `globalThis.__lumaBooted` guard registers the handlers once per process. Handlers run inside the transition's transaction and must be exactly-once by their own constraints.

| Hook | Handlers, in order |
|---|---|
| `completed` | `recognizeBookingRevenue` → `earnCommissions` → `touchCustomerVisit` → `consumeForBooking` (membership sessions) → `earnForBooking` (loyalty) → `consumeMaterialsForBookingItem` for each current item |
| `refundDue` | `refundBookingDue` (system-approved refunds across captured payments, newest first) |
| `released` (expired, cancelled, no_show) | `recognizeRetainedOnClose` (skipped for `expired`) → `releaseSeats` → `releaseForBooking` (membership reservations) |
| `slotFreed` | `offerFreedSlot` (waitlist) |
| `onRefundSucceeded` (payments) | `reverseForRefund` (loyalty) → `restoreOnRefund` (gift cards) |
| `paymentTargets.order.onCaptured` | `markOrderPaid`; if it changed the order, record a server-side `order_paid` analytics event |
| `paymentTargets.order.onFailed` | no-op (the customer may retry until the order expires) |

`paymentTargets.giftCard.onCaptured` and `paymentTargets.membership.onCaptured` are **not wired**; they throw "not wired" if called. They are not reached today because gift cards and memberships are sold only at the counter. See [PAYMENT_FLOW.md](PAYMENT_FLOW.md).

## Known gaps and inconsistencies

- `booking_confirmed` analytics events are recorded only by `applyHoldOutcome(… 'confirmed')`. Confirmations through `approve` (manual approval) and late-payment reallocation (`tryReallocateExpired`) record no conversion event.
- `expireBookings` always writes `from_status: 'held'` in the event, even when the booking was `pending_payment`.
- Rescheduled items snapshot the service name without the variant suffix that `createHold` appends.
- Rescheduling has no policy window of its own (for example "no reschedule within N hours"); only "before start" applies for customers.
- Notifications link to `/account/bookings/{id}`, `/staff` and `/account/waitlist/{id}`, but there are no pages at those paths in `src/app` yet (dashboard and portal UIs are being completed in parallel).

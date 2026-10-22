# Data model

Source of truth: `db/migrations/*.sql`. Generated TypeScript types: `src/server/db/schema.generated.ts` (regenerate with `scripts/gen-db-types.sh`). The schema has **139 application tables** in `public` (plus `schema_migrations`). 124 of them have row-level security enabled: every table with a `tenant_id` column, plus `tenants`.

## Conventions

| Convention | Rule |
|---|---|
| Keys | `uuid` primary keys (`gen_random_uuid()`). Readable numbers (`bookings.number`, `orders.number`, `invoices.number`) are unique per tenant and come from `tenant_counters`. |
| Tenant ownership | Every business-owned row has `tenant_id`. Children reference parents through **composite `(tenant_id, id)` foreign keys**, so a row can never point at another tenant's row. Parents declare `unique (tenant_id, id)` for this. |
| Money | `bigint` **minor units (halalas for SAR)** plus a `char(3)` currency, default `SAR`. Percentages are basis points (`*_bp`, 0–10000). `pg` parses `int8` to a JS number and **throws** if a value leaves the safe-integer range (`src/server/db/client.ts`). |
| Quantities | Inventory: `numeric(14,3)` with units `piece/ml/l/g/kg`. |
| Time | Instants: `timestamptz`. Wall-clock schedule times: `time` in the branch timezone (default `Asia/Riyadh`). Calendar dates: `date`, returned to JS as `'YYYY-MM-DD'` strings. Ranges: `tstzrange` (half-open). |
| Timestamps | `created_at`, and `updated_at` maintained by the `touch_updated_at` trigger, which `app.apply_conventions()` adds to every table that has the column. |
| Concurrency | `version int` columns for optimistic concurrency; a stale write returns 409 `version_conflict`. |
| Snapshots | Bookings, booking items, orders, order items, invoices, memberships and site versions copy names, prices, durations and terms at transaction time. |
| Archive, don't delete | `archived_at` / `status` columns; reviews and decisions are never deleted. |
| Append-only | `app.make_append_only(table)` revokes `UPDATE`/`DELETE` from the runtime role and adds a `before update or delete` trigger that raises `42501`. Corrections are new offsetting rows. |

## Migration numbering

- Files are applied in **lexical order**, each in its own transaction, as the owner role (`src/server/db/migrator.ts`).
- `0001`–`0024` are the foundation series. `0100`, `0200`, `0300`, `0400` and `0500` are extension blocks reserved per workstream (builder/publishing, commerce operations, policy/customers, marketing/analytics, platform admin). Lexical order puts every `01xx`–`05xx` file after `0024`.
- Every applied file is SHA-256 checksummed in `schema_migrations`. Editing an applied file aborts the run: "Migration X was modified after being applied. Create a new migration instead."
- `{{APP_ROLE}}` in SQL is replaced with `DB_APP_ROLE` (default `luma_app`). Most migrations end with `select app.apply_conventions('{{APP_ROLE}}')`.
- A session advisory lock (`pg_advisory_lock(727274)`) serialises concurrent runners.
- `0010` revokes all access to `schema_migrations` from the runtime role. `0023` makes `apply_conventions()` re-apply the append-only and `schema_migrations` revocations after it grants table privileges. Before `0023`, re-granting silently restored `UPDATE`/`DELETE`; the trigger still blocked the writes.

| File | Adds |
|---|---|
| 0001_foundation | extensions, `app` schema, RLS helpers, `apply_conventions`, `make_append_only`, `forbid_mutation` |
| 0002_identity_tenancy | users, sessions, codes, plans, tenants, settings, branches, memberships, invitations, subscriptions, support grants, audit, idempotency, outbox, jobs, notifications |
| 0003_catalog_staff | assets, catalog, staff, resources, schedules, leave, attendance |
| 0004_customers_booking | tenant customers, consents, bookings/items/allocations/events, reviews, group sessions, waitlist |
| 0005_commerce_payments_finance | products, inventory, carts, coupons, orders, payments, refunds, provider events, journal, commissions, expenses, invoices |
| 0006_loyalty_gifts_memberships | loyalty, rewards, coupon redemptions, gift cards, memberships and entitlements |
| 0007_builder | brand settings, pages, drafts, versions, preview tokens, templates, components, domains, onboarding, proposals |
| 0008_policy | incidents, evidence, incident reviews, policy rules/decisions, appeals |
| 0009_marketing_ai_analytics | analytics events, metrics, Loom plans/versions/recommendations, segments, campaigns, suppression, trends, AI jobs/runs |
| 0010–0024 | hardening, null-tenant inserts, reference plans, settings confirmation, asset lookup, notification reads, booking revisions, sandbox provider, group/waitlist columns, loyalty/gift columns, finance documents, platform notifications, conversion sessions, conventions fix, platform evidence access |
| 0100–0500 | builder publishing + starter templates, commerce operations, policy/customer lifecycle, marketing/analytics extensions, platform admin (MFA, versions, test invoices) |

## Tables by domain

The constraints listed are the ones that carry business invariants. Every tenant table also has composite tenant FKs to its parents, as described above.

### Identity and sessions (central, no `tenant_id`, no RLS)

| Table | Purpose | Key constraints |
|---|---|---|
| `users` | Central LUMA account | `email citext unique`, `phone unique` with an E.164 CHECK, CHECK that email or phone is present, `status in (active, suspended, deleted)`, `is_demo` flag; MFA columns (`mfa_totp_secret_enc` AES-256-GCM, `mfa_pending_secret_enc`, `mfa_last_step` for replay protection), CHECK `mfa_enabled_at` implies a secret |
| `customer_profiles` | Customer profile per user | PK `user_id` |
| `platform_roles` | LUMA admin roles | role CHECK (4 roles); partial unique `(user_id, role) where revoked_at is null` |
| `sessions` | Opaque session tokens | `token_hash bytea unique` (HMAC), absolute and idle expiry, `reauthenticated_at` (step-up), `mfa_verified_at` |
| `verification_codes` | OTP and recovery codes | only `secret_hash` is stored; `attempts` / `max_attempts`; purpose and channel CHECKs |
| `rate_limit_buckets` | Fixed-window rate limits shared by all instances | PK `key` |
| `idempotency_records` | Stored results of idempotent operations | `unique (scope, operation, key)`; key length 8–200; expires after 24h |
| `dev_message_outbox` | Development-only message sink (`DEV_OTP_ECHO`) | none; production code paths never write here |

### Plans, tenants and subscriptions

| Table | Purpose | Key constraints |
|---|---|---|
| `plans` | LUMA plans (Sanaa, Wahaj, Fareed) | `code unique`; prices **nullable** (NULL means pricing not configured), `price_is_test`; `trial_days` 0–90, `grace_days` 0–60; `version` |
| `plan_features` | Feature switches and limits per plan | PK `(plan_id, feature_key)`; `limit_value` NULL means unlimited |
| `tenants` | Businesses | `slug citext unique` with a CHECK pattern; `status in (onboarding, active, suspended, closed)`; composite FK `(id, published_version_id)` to `site_versions(tenant_id, id)`; RLS policy `tenant_self` |
| `tenant_settings` | Booking, payment, tax, legal and contact policy | PK `tenant_id`; CHECKs: `slot_increment_min in (5,10,15,20,30,60)`, `hold_ttl_sec` 60–3600, `deposit_mode in (none, percent, fixed)`, `*_bp` 0–10000, `any_staff_rule` enum, `waitlist_offer_ttl_min` 5–1440 |
| `branches` | Locations | partial unique: one active primary per tenant; `version` |
| `branch_hours` | Opening hours | CHECK `closes > opens`; several ranges per weekday allowed |
| `tenant_counters` | Readable number sequences | PK `(tenant_id, kind)` |
| `tenant_memberships` | User ↔ business with role | `unique (tenant_id, user_id)`; partial unique: **exactly one active owner per tenant**; partial unique active staff profile per tenant; `granted_capabilities` / `revoked_capabilities` arrays |
| `invitations` | Team invitations | `token_hash unique`; role cannot be `owner` (CHECK) |
| `subscriptions` | Business plan with LUMA | status CHECK; partial unique: one current subscription (`trialing/active/past_due/paused`) per tenant; `overage_state jsonb`; `version` |
| `subscription_events` | Subscription history | **append-only** |
| `usage_counters` | Usage per metric per period | PK `(tenant_id, metric, period_start)`; holds the atomic AI budget counter |
| `platform_invoices` | LUMA subscription invoices | `number unique`; CHECK **`is_test`** (0500: no real billing exists) |
| `support_access_grants` | Time-limited support access | reason of 10 or more characters; `access_level in (read, write)`; CHECK `expires_at > starts_at and expires_at <= starts_at + 24h`; revocation columns |

### Infrastructure

| Table | Purpose | Key constraints |
|---|---|---|
| `audit_logs` | Audit trail (redacted metadata) | **append-only**; `actor_kind` CHECK; `support_grant_id`; nullable `tenant_id` for platform and auth events |
| `outbox_events` | Transactional outbox | `dedupe_key unique`; pending index |
| `job_runs` | Background jobs | `dedupe_key unique`; status CHECK; `max_attempts`; `locked_by` / `locked_at` |
| `notifications` | In-app notifications (cross-tenant per person) | partial unique `(user_id, dedupe_key)`; `target_path` CHECK (internal relative path only); 180-day expiry |
| `notification_deliveries` | Email/SMS/WhatsApp delivery records | `status in (pending, simulated, sent, delivered, failed, suppressed)`; `dedupe_key unique`; masked destination only |
| `assets` | Uploaded files | `storage_key unique`; bytes 1 to 20 MiB; `visibility in (public, private)`; nullable `tenant_id` (platform assets) |

### Catalog, team and schedules

| Table | Purpose | Key constraints |
|---|---|---|
| `categories` | Service and product categories | `unique (tenant_id, kind, slug)`; ar or en name required |
| `services` | Services | `price_minor >= 0`; `duration_min` 5–720; buffers 0–240; `booking_mode in (individual, group)`; optional per-service notice and window; `cost_minor` (confidential); `version` |
| `service_variants`, `service_addons` | Options and add-ons | price and duration CHECKs |
| `service_staff` | Qualified staff per service | PK `(tenant_id, service_id, staff_id)`; optional price and duration overrides |
| `service_packages`, `service_package_items` | Packages | — |
| `service_price_proposals` | Price change proposals (manual or from a recommendation) | status CHECK |
| `staff_profiles` | Specialists | `sort` (tie-break order); `is_public` |
| `staff_branch_assignments` | Staff ↔ branch | PK triple |
| `resource_types`, `resources` | Rooms and chairs | each resource is **one unit** (three chairs = three resources) |
| `service_resource_requirements` | Resource needs per service | `quantity` 1–5 |
| `working_hours` | Weekly hours per staff per branch | CHECK `end_time > start_time`; effective date range |
| `staff_breaks` | Recurring or dated breaks | CHECK exactly one of `weekday` / `on_date` |
| `shift_overrides` | Day off / replacement / extra hours | CHECK times present unless `kind = 'off'` |
| `time_blocks` | Ad-hoc blocked time | CHECK exactly one of `staff_id` / `resource_id`; GiST index |
| `leave_requests` | Leave | `during tstzrange`, status CHECK, `affected_booking_ids` |
| `attendance_events` | Clock in/out | **append-only** (corrections reference `corrects_event_id`) |

### Customers and bookings

| Table | Purpose | Key constraints |
|---|---|---|
| `tenant_customers` | A business's relationship with a person | partial unique `(tenant_id, user_id)`; `private_notes`; `version`, `archived_at` |
| `customer_consents` | Consent history | **append-only**; latest row per (subject, scope, channel, purpose) is the effective state; nullable `tenant_id` means platform scope |
| `bookings` | Appointment header | status CHECK (11 states) separate from `payment_status` (7 states); CHECKs `ends_at > starts_at`, `deposit_due_minor <= total_minor`, `refunded_minor <= paid_minor`; `policy_snapshot`, `payment_terms` jsonb; `revision`; `analytics_session_id` pattern CHECK; `unique (tenant_id, number)` |
| `booking_items` | Services in a booking | snapshot names, prices and durations; `unique (booking_id, revision, sequence)`; `superseded_at` for rescheduled history |
| `booking_allocations` | Staff and resource time, including **holds** | see below |
| `booking_events` | Booking lifecycle history | **append-only** |
| `reviews` | One review per completed booking | `unique (tenant_id, booking_id)`; rating 1–5; trigger `review_requires_completed_visit`; CHECK non-published status needs a moderation reason |
| `group_sessions`, `group_session_bookings` | Shared-capacity sessions | CHECK `seats_taken between 0 and capacity`; `unique (tenant_id, booking_id)` |
| `waitlist_entries`, `waitlist_offers` | Waitlist | partial unique **one pending offer per `(tenant_id, staff_id, slot_start)`** |

`booking_allocations` is the final authority against double booking:

```sql
constraint booking_allocations_staff_no_overlap exclude using gist (
  tenant_id with =, staff_id with =, during with &&
) where (state in ('held', 'confirmed') and staff_id is not null),
constraint booking_allocations_resource_no_overlap exclude using gist (
  tenant_id with =, resource_id with =, during with &&
) where (state in ('held', 'confirmed') and resource_id is not null)
```

It also has CHECK exactly one of `staff_id` / `resource_id`, CHECK `state <> 'held' or expires_at is not null`, and (from 0018) CHECK that the allocation belongs to a booking or a group session.

### Commerce and inventory

| Table | Purpose | Key constraints |
|---|---|---|
| `products`, `product_images`, `product_variants` | Shop catalog | partial unique SKU per tenant; partial unique default variant per product; `returnable`; `version` |
| `inventory_items` | Stock per branch | **CHECK `on_hand >= 0`, `reserved >= 0`, `reserved <= on_hand`**; CHECK retail items need a variant |
| `stock_movements` | Stock ledger | **append-only**; partial unique `(inventory_item_id, kind, ref_type, ref_id)` for reservation/sale/release/consumption/return (exactly once per business event) |
| `service_material_recipes` | Materials consumed per service | quantity > 0 |
| `carts`, `cart_items` | Carts | partial unique open cart per user, and per anonymous token hash |
| `coupons`, `coupon_redemptions` | Coupons | `unique (tenant_id, code)`; CHECK `redemptions_count <= max_redemptions`; one redemption per coupon per booking or order |
| `orders`, `order_items` | Orders | status CHECK; `refunded_minor <= paid_minor`; `unique (order_id, variant_id)`; item snapshots |
| `stock_reservations` | Reserved stock per order line | `unique (order_item_id)` |
| `fulfillments`, `returns` | Pickup and returns | — |
| `order_events` | Order history | **append-only** |

### Payments and finance

| Table | Purpose | Key constraints |
|---|---|---|
| `payment_accounts` | The business's provider account | `provider in (sandbox, moyasar, tap, tabby, tamara)`; `unique (tenant_id, provider, mode)`; `credentials_ref` (a reference, never a secret) |
| `payments` | Every payment (online, on-site, gift card) | **CHECK `num_nonnulls(booking_id, order_id, gift_card_id, customer_membership_id) = 1`**; CHECK cash/terminal payments need `collected_by` and `cash_reference`; `unique (tenant_id, idempotency_key)`; `unique (provider, provider_payment_id)`; `needs_reconciliation` |
| `payment_attempts` | Provider attempts | — |
| `refunds` | Refunds | `unique (tenant_id, idempotency_key)`; status CHECK; `requested_by_system` |
| `provider_events` | Raw webhooks | **`unique (provider, provider_event_id)`** (dedupe); `signature_valid`; status CHECK |
| `sandbox_provider_payments`, `sandbox_provider_refunds` | The simulated provider's own records (no `tenant_id`, no RLS) | used by reconciliation as "provider truth" |
| `reconciliation_runs` | Reconciliation results | status CHECK |
| `payouts` | Provider payouts | **defined but not used by application code** |
| `financial_entries` | Double-entry journal | **append-only**; CHECK each line is debit xor credit; account CHECK (19 accounts); **deferred constraint trigger `financial_entries_balanced`**: at commit, every `entry_group_id` must sum debit − credit = 0 |
| `expenses` | Expenses | CHECK voided expenses need a `void_reason` |
| `commission_rules`, `commission_entries` | Commissions | partial unique **one `earned` entry per booking item**; entries **append-only** (reversals are new rows) |
| `invoices`, `invoice_items` | Receipts, invoices, credit notes | **append-only**; `unique (tenant_id, number)`; partial uniques: one receipt per payment, one invoice per booking, one invoice per order |
| `finance_exports` | CSV export jobs | status CHECK |

```sql
create constraint trigger financial_entries_balanced after insert on financial_entries
  deferrable initially deferred for each row execute function app.check_journal_balanced();
```

### Loyalty, gift cards and memberships

| Table | Purpose | Key constraints |
|---|---|---|
| `loyalty_programs` | Per-tenant program | PK `tenant_id` |
| `loyalty_accounts` | Cached balance | CHECK `balance >= 0`; `unique (tenant_id, tenant_customer_id)` |
| `points_entries` | Points ledger | **append-only**; CHECK `balance_after >= 0`; partial unique `(account_id, kind, ref_type, ref_id)` |
| `rewards`, `reward_redemptions` | Rewards and redemptions (as coupons) | `unique (tenant_id, idempotency_key)` |
| `gift_cards` | Gift cards | `code_hash unique` (keyed hash), only `code_last4` in clear; CHECK `balance_minor between 0 and initial_minor` |
| `gift_card_entries` | Gift card ledger | **append-only**; CHECK `balance_after_minor >= 0`; partial unique per `(gift_card_id, kind, ref_type, ref_id)` |
| `membership_plans`, `membership_plan_items` | Prepaid plans | sessions 1–500, validity 1–1095 days |
| `customer_memberships` | Sold memberships | `plan_snapshot`; partial unique (on `payments`): one captured payment per membership |
| `membership_entitlements` | Sessions per service | **CHECK `used + reserved <= total`**; `unique (membership_id, service_id)` |
| `entitlement_reservations` | Session reserved per booking item | `unique (booking_item_id)` |

### Storefront builder

| Table | Purpose | Key constraints |
|---|---|---|
| `brand_settings` | Theme tokens (one row per tenant) | enum CHECKs for radius, button, card and density; `spacing_scale` 0.75–1.50; `version` |
| `store_pages` | Pages | `unique (tenant_id, slug)`; partial unique: one active page per non-custom kind |
| `site_drafts` | Layout draft | `version` |
| `page_drafts` | Block tree per page | PK `(tenant_id, page_id)`; `version` |
| `site_versions` | Immutable published snapshots | **append-only**; `unique (tenant_id, version_number)` |
| `preview_tokens` | Draft preview links | `token_hash unique`; CHECK `expires_at <= created_at + 7 days` |
| `templates` | Platform starter templates (no tenant) | `key unique`; status `draft/approved/retired` |
| `builder_components` | Platform on/off switch per block type (no tenant) | PK `type` |
| `domain_mappings` | Custom domains | **defined but not used by application code** |
| `onboarding_progress` | Seven-step onboarding state | `current_step` 1–8; `version` |
| `customization_proposals` | Assistant proposals | status `proposed/accepted/rejected/failed/invalid/undone`; FK to `ai_runs` |

### Policy

| Table | Purpose | Key constraints |
|---|---|---|
| `customer_incidents` | Business-reported incidents | CHECK no-show and late-cancellation incidents need a booking; partial unique **one per `(tenant, booking, type)`** unless rejected; CHECK escalation columns consistent |
| `incident_evidence` | Evidence (assets or notes) | `retain_until` (2 years by default) |
| `incident_reviews` | Review trail | **append-only**; `reviewer_scope in (tenant, platform)` |
| `policy_rules` | Configurable criteria (experimental flag) | CHECK `(scope = 'tenant') = (tenant_id is not null)` |
| `policy_decisions` | Restrictions on a customer | CHECKs: scope ↔ tenant; **`suspend_account` only at platform scope**; expiry after effective; non-active decisions need `ended_at`; partial unique: a decision is superseded at most once |
| `appeals` | Customer appeals | partial unique **one open appeal per item**; CHECK `(review_scope = 'tenant') = (tenant_id is not null)` |

### Marketing, AI and analytics

| Table | Purpose | Key constraints |
|---|---|---|
| `analytics_events` | Storefront events | PK = client `event_id` (dedupe); type CHECK; `is_excluded` + `exclusion_reason` |
| `daily_metrics` | Rolled-up metrics | PK `(tenant_id, day, metric, dimension)` |
| `metric_snapshots` | Trusted metric snapshot for Loom (with hash and `data_as_of`) | — |
| `marketing_preferences` | Goals, budget, channels, schedule | `max_discount_bp` 0–10000 |
| `marketing_plans` | Monthly and weekly plans | status CHECK; CHECK weekly plans need a parent unless they are examples |
| `plan_versions` | Immutable plan content | **append-only**; `unique (plan_id, version)` |
| `plan_comments` | Comments | length 1–2000 |
| `recommendations` | Recommendations with evidence and provenance | category, horizon and confidence CHECKs; `fingerprint` |
| `campaign_segments` | Allowlisted segment definitions | — |
| `campaigns` | Campaigns | status CHECK; `holdout_bp` 0–5000; `frequency_cap_days` 0–90; `quiet_hours`; partial unique `tracking_code` |
| `campaign_events` | Delivery and conversion events | **append-only**; partial unique: one `converted` event per `(campaign, ref_type, ref_id)` |
| `suppression_list` | Opt-outs | `unique (tenant_id, channel, destination_hash)` |
| `trend_sources`, `trend_observations`, `trend_assessments` | Trend radar | `unique (source_id, content_hash)`; partial unique source URL per tenant; `evidence_strength` CHECK |
| `prompt_versions` | Registered prompts and output schemas (no tenant) | PK `(key, version)` |
| `ai_jobs` | AI job state | partial unique **one live job per `(tenant, kind, period_key)`** (queued or running) |
| `ai_runs` | Provenance of every AI call | **append-only**; status CHECK; tokens, latency, `cost_usd_micros` (NULL without a configured price); `cache_key` |
| `marketing_calendar_events` | Owner-verified dates | `source_url` must be `https://` |
| `performance_settings` | Employee indicator weights and minimum samples | minimum-sample CHECKs |

### Append-only tables (18)

`ai_runs`, `attendance_events`, `audit_logs`, `booking_events`, `campaign_events`, `commission_entries`, `customer_consents`, `financial_entries`, `gift_card_entries`, `incident_reviews`, `invoice_items`, `invoices`, `order_events`, `plan_versions`, `points_entries`, `site_versions`, `stock_movements`, `subscription_events`.

## Row-level security model

Defined in `0001_foundation.sql` and `src/server/db/client.ts`.

| Element | Definition |
|---|---|
| `app.current_tenant()` | `current_setting('app.tenant_id', true)::uuid` |
| `app.is_system()` | `current_setting('app.scope', true) = 'system'` |
| `app.tenant_visible(t)` | `app.is_system() or (t is not null and t = app.current_tenant())` |
| Policy `tenant_isolation` | Added by `apply_conventions()` to every table with `tenant_id`: `using (app.tenant_visible(tenant_id)) with check (app.tenant_visible(tenant_id))` |
| Policy `tenant_self` on `tenants` | Same check on `id` |
| Policy `null_tenant_insert` (0011) | On `audit_logs`, `notification_deliveries`, `notifications`, `outbox_events`, `job_runs` and `customer_consents`: `for insert with check (tenant_id is null)`. Any scope may **insert** platform- or user-level rows, but they can be **read** only in system scope or through definer functions. |

Transaction scopes (all use `set_config(..., true)`, so they are transaction-local):

| Helper | Settings | Use |
|---|---|---|
| `withTenant(tenantId, fn)` | `app.tenant_id = <uuid>`, `app.scope = 'tenant'` | All tenant work. The tenant id must come from a resolved membership, support grant, published storefront or verified job, never from request input. |
| `withSystem(reason, fn)` | `app.scope = 'system'` | Cross-tenant work: platform admin, webhook intake before the tenant is known, job fan-out, sweepers. The caller must pass a reason. |
| `withCentral(fn)` | `app.scope = 'central'` | Central tables only (users, sessions, plans). Tenant tables return no rows. |
| `db()` with no scope | none | Tenant tables return no rows. |

Because `luma_app` does not own the tables and has no `BYPASSRLS`, a query that forgets `where tenant_id = ...` still sees only the current tenant's rows.

## `SECURITY DEFINER` functions

All live in schema `app`, are owned by the migration role (which owns the tables and so bypasses RLS), set `search_path = public`, and return only allowlisted columns. The runtime role gets `EXECUTE` on them. The list below matches the 18 functions with `prosecdef = true` in a migrated database.

| Function | Migration | Why it exists |
|---|---|---|
| `resolve_tenant_slug(slug)` | 0002 | Resolve a public slug to the tenant's basic fields before any tenant scope exists |
| `memberships_for_user(user)` | 0002 | The caller's own active memberships across tenants (business selector, access resolution) |
| `invitation_by_token(hash)` | 0002 | Look up an invitation by token hash before tenant scope |
| `notifications_for_user(user, before, limit)` | 0002 | A person's notifications across tenants (the bell is global); limit capped at 100 |
| `customer_bookings(user, limit, before)` | 0004 | The customer's own bookings at every business, with item names only |
| `customer_orders(user, limit)` | 0005 | The customer's own orders at every business |
| `preview_token_tenant(hash)` | 0007 | Map a live preview token to its tenant |
| `platform_decisions_for_customer(user)` | 0008 | Active platform-scope decisions for a customer: **action and customer-facing explanation only**, never reasons or evidence, so tenant checkout can honour them |
| `asset_for_serving(id)` | 0014 | What the media route needs to authorise and stream a file before the tenant is known |
| `mark_notifications_read(user, ids)` | 0015 | Mark the caller's own notifications read across tenants |
| `unread_notifications(user)` | 0015 | Unread count for the caller |
| `customer_booking_ref(user, booking)` | 0016 | Resolve the tenant of a booking only if it belongs to this customer (cancel or reschedule from `/account`) |
| `payment_by_provider_ref(provider, ref)` | 0017 | Webhook intake: payment id → tenant |
| `refund_by_provider_ref(ref)` | 0017 | Webhook intake: refund id → tenant |
| `waitlist_offer_ref(user, offer)` | 0018 | Resolve the tenant of a waitlist offer only for the customer who received it |
| `insert_platform_notifications(...)` | 0021 | Insert NULL-tenant notifications with `ON CONFLICT` dedupe from inside a tenant transaction (RLS hides NULL-tenant rows from the conflict check). Writes only NULL-tenant rows; `EXECUTE` is revoked from `public`. |
| `evidence_escalated(asset)` | 0024 | Lets a platform policy reviewer view an evidence asset **only** if its incident was escalated to LUMA |
| `customer_reviewable_bookings(user, limit)` | 0300 | The customer's completed, not yet reviewed visits |

The other `app.*` functions (`current_tenant`, `is_system`, `tenant_visible`, `touch_updated_at`, `forbid_mutation`, `apply_conventions`, `make_append_only`, `check_journal_balanced`, `review_requires_completed_visit`) are not definer functions.

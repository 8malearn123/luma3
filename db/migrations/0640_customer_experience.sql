-- 0640 Customer experience (phase 2): coupons on bookings, review requests after
-- the visit, online gift card / membership purchase with scheduled gift
-- delivery, acquisition source ("how did you hear about us?") and
-- "remember me" sessions. See docs/CUSTOMER_EXPERIENCE.md.

-- ── Remember me ──────────────────────────────────────────────────────────────
-- persistent = the cookie carries an expiry (30 days). Non-persistent sessions
-- use a browser-session cookie and a short server-side lifetime.
alter table sessions add column persistent boolean not null default true;

-- ── Review requests after the visit ─────────────────────────────────────────
-- off | immediately (next job run after completion) | after_hours (delay).
-- Optional single reminder N hours after the first request.
alter table tenant_settings add column review_request_mode text not null default 'after_hours'
  check (review_request_mode in ('off', 'immediately', 'after_hours'));
alter table tenant_settings add column review_request_delay_hours int not null default 3
  check (review_request_delay_hours between 1 and 168);
alter table tenant_settings add column review_reminder_hours int
  check (review_reminder_hours is null or review_reminder_hours between 1 and 336);

create table review_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  booking_id uuid not null,
  customer_user_id uuid not null references users(id),
  completed_at timestamptz not null,
  first_sent_at timestamptz not null default now(),
  reminder_sent_at timestamptz,
  status text not null default 'sent' check (status in ('sent', 'reminded', 'reviewed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, booking_id),
  foreign key (tenant_id, booking_id) references bookings(tenant_id, id)
);
create index review_requests_reminder_idx on review_requests (first_sent_at) where reminder_sent_at is null and status = 'sent';

-- ── Online gift cards: scheduled direct send to the recipient ───────────────
-- The code is encrypted at rest (AES-256-GCM, key derived from AUTH_SECRET) so
-- it can be delivered at the chosen time and shown on the recipient page; the
-- card itself still stores only the keyed hash + last 4 characters.
create table gift_card_deliveries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  gift_card_id uuid not null,
  purchaser_user_id uuid not null references users(id),
  recipient_name text not null check (length(recipient_name) between 1 and 80),
  recipient_phone text,
  recipient_email text,
  message text check (message is null or length(message) <= 300),
  send_at timestamptz not null,
  status text not null default 'awaiting_payment'
    check (status in ('awaiting_payment', 'scheduled', 'sent', 'simulated', 'failed', 'cancelled')),
  attempts int not null default 0,
  next_attempt_at timestamptz,
  last_error text,
  channels text[] not null default '{}',
  sent_at timestamptz,
  code_ciphertext text not null,
  view_token_hash bytea unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (gift_card_id),
  check (recipient_phone is not null or recipient_email is not null),
  foreign key (tenant_id, gift_card_id) references gift_cards(tenant_id, id)
);
create index gift_card_deliveries_due_idx on gift_card_deliveries (send_at) where status = 'scheduled';

-- ── Acquisition source ("كيف عرفتِ عنا؟") ───────────────────────────────────
-- First-touch, per business relationship. Inferred from storefront analytics
-- attribution; asked only when unknown.
alter table tenant_customers add column acquisition_source text check (acquisition_source in (
  'referral', 'marketplace', 'campaign', 'instagram', 'tiktok', 'snapchat', 'google', 'x', 'whatsapp',
  'website', 'friend', 'walk_by', 'direct', 'other'));
alter table tenant_customers add column acquisition_method text check (acquisition_method in ('inferred', 'asked'));
alter table tenant_customers add column acquisition_detail jsonb;
alter table tenant_customers add column acquisition_at timestamptz;
create index tenant_customers_acquisition_idx on tenant_customers (tenant_id, acquisition_source);

-- Answer given at registration (optional); used once as the fallback for the
-- first business relationship whose source cannot be inferred.
alter table customer_profiles add column heard_from text check (heard_from in (
  'instagram', 'tiktok', 'snapchat', 'google', 'x', 'whatsapp', 'friend', 'walk_by', 'marketplace', 'other'));
alter table customer_profiles add column heard_from_used_at timestamptz;

select app.apply_conventions('{{APP_ROLE}}');

-- 0660 Expert experience: event bookings with a deposit («حجوزات المناسبات»),
-- a before/after portfolio («أعمالي») and an Instagram section that is ready
-- for the official Graph API.
--
-- Event bookings
--   requested → quoted → pending_payment → confirmed → completed
--   requested → declined (business)        quoted → expired (quote expiry)
--   requested | quoted | pending_payment | confirmed → cancelled (customer, business or system)
-- The expert's time is reserved with the SAME exclusion constraints as
-- individual bookings: a booking_allocations row owned by the event booking
-- (held while the customer pays the deposit, confirmed on capture). Normal
-- availability therefore respects it, and no booking can overlap it.
--
-- Payments: purpose 'event' with payments.event_booking_id. Journal:
--   Deposit / balance captured   Dr cash|provider_clearing   Cr customer_deposits
--   Event completed              Dr customer_deposits        Cr service_revenue (net) + tax_payable
--   Cancelled, deposit retained  Dr customer_deposits        Cr service_revenue (retained)
--   Refund                       Dr customer_deposits        Cr cash|provider_clearing

create table event_settings (
  tenant_id uuid primary key references tenants(id),
  enabled boolean not null default true,
  default_deposit_bp int not null default 3000 check (default_deposit_bp between 0 and 10000),
  -- Customer cancellations at least this many days before the event get the deposit back.
  free_cancellation_days int not null default 7 check (free_cancellation_days between 0 and 365),
  quote_validity_days int not null default 3 check (quote_validity_days between 1 and 30),
  max_people int not null default 30 check (max_people between 1 and 500),
  intro_ar text check (char_length(intro_ar) <= 1000),
  intro_en text check (char_length(intro_en) <= 1000),
  updated_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table event_bookings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  number text not null,
  tenant_customer_id uuid not null,
  customer_user_id uuid not null references users(id),
  status text not null default 'requested' check (status in ('requested', 'quoted', 'pending_payment', 'confirmed', 'completed', 'declined', 'expired', 'cancelled')),
  occasion text not null check (occasion in ('wedding', 'engagement', 'graduation', 'group_makeup', 'party', 'other')),
  event_date date not null,
  start_time time not null,
  timezone text not null,
  starts_at timestamptz not null,
  ends_at timestamptz,
  location_type text not null check (location_type in ('venue', 'studio')),
  location_text text check (char_length(location_text) <= 300),
  people_count int not null check (people_count between 1 and 500),
  service_ids uuid[] not null default '{}' check (cardinality(service_ids) <= 20),
  notes text check (char_length(notes) <= 2000),
  contact_phone text check (char_length(contact_phone) <= 30),
  -- Quote (set by the business).
  staff_id uuid,
  duration_min int check (duration_min between 15 and 1440),
  prep_before_min int not null default 0 check (prep_before_min between 0 and 600),
  prep_after_min int not null default 0 check (prep_after_min between 0 and 600),
  subtotal_minor bigint check (subtotal_minor >= 0),
  tax_minor bigint check (tax_minor >= 0),
  total_minor bigint check (total_minor >= 0),
  deposit_minor bigint check (deposit_minor >= 0),
  currency char(3) not null default 'SAR',
  quote_note text check (char_length(quote_note) <= 1000),
  quote_expires_at timestamptz,
  quoted_at timestamptz,
  quoted_by uuid references users(id),
  quote_version int not null default 0,
  -- Cancellation policy and tax captured with the quote; cancellation reads this, never current settings.
  policy_snapshot jsonb not null default '{}'::jsonb,
  paid_minor bigint not null default 0 check (paid_minor >= 0),
  refunded_minor bigint not null default 0 check (refunded_minor >= 0),
  payment_expires_at timestamptz,
  accepted_at timestamptz,
  confirmed_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  cancel_source text check (cancel_source in ('customer', 'business', 'system')),
  cancel_reason text check (char_length(cancel_reason) <= 500),
  decline_reason text check (char_length(decline_reason) <= 500),
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, number),
  check (location_type <> 'venue' or location_text is not null),
  check (status not in ('quoted', 'pending_payment', 'confirmed', 'completed')
    or (staff_id is not null and duration_min is not null and total_minor is not null and deposit_minor is not null and ends_at is not null and quote_expires_at is not null)),
  check (deposit_minor is null or total_minor is null or deposit_minor <= total_minor),
  check (ends_at is null or ends_at > starts_at),
  foreign key (tenant_id, tenant_customer_id) references tenant_customers(tenant_id, id),
  foreign key (tenant_id, staff_id) references staff_profiles(tenant_id, id)
);
create index event_bookings_status_idx on event_bookings (tenant_id, status, starts_at);
create index event_bookings_customer_idx on event_bookings (tenant_id, customer_user_id, created_at desc);

-- Time reservation owned by an event booking (same exclusion constraints as bookings).
alter table booking_allocations add column event_booking_id uuid;
alter table booking_allocations add constraint booking_allocations_event_fk foreign key (tenant_id, event_booking_id) references event_bookings(tenant_id, id);
alter table booking_allocations drop constraint booking_allocations_owner_chk;
alter table booking_allocations add constraint booking_allocations_owner_chk check (booking_id is not null or group_session_id is not null or event_booking_id is not null);
create index booking_allocations_event_idx on booking_allocations (tenant_id, event_booking_id) where event_booking_id is not null;

-- Event deposits and balances go through the normal payments table.
alter table payments add column event_booking_id uuid;
alter table payments add constraint payments_event_fk foreign key (tenant_id, event_booking_id) references event_bookings(tenant_id, id);
alter table payments drop constraint payments_purpose_check;
alter table payments add constraint payments_purpose_check check (purpose in ('booking', 'order', 'gift_card', 'membership', 'event'));
alter table payments drop constraint payments_check;
alter table payments add constraint payments_check check (num_nonnulls(booking_id, order_id, gift_card_id, customer_membership_id, event_booking_id) = 1);
create index payments_event_idx on payments (tenant_id, event_booking_id) where event_booking_id is not null;

-- ── Portfolio («أعمالي»): before/after pairs or single images ─────────────────
create table portfolio_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  before_asset_id uuid,
  after_asset_id uuid not null,
  caption_ar text check (char_length(caption_ar) <= 160),
  caption_en text check (char_length(caption_en) <= 160),
  category text check (char_length(category) <= 40),
  service_id uuid,
  is_visible boolean not null default true,
  sort int not null default 0,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  check (before_asset_id is null or before_asset_id <> after_asset_id),
  foreign key (tenant_id, service_id) references services(tenant_id, id)
);
create index portfolio_items_sort_idx on portfolio_items (tenant_id, sort, created_at);

-- ── Instagram connection (official Graph API only; never scraping) ───────────
-- The handle is enough for the «تابعينا على إنستقرام» card. A connection stores
-- the Graph API account id and an encrypted long-lived token; posts are cached
-- here by a sync so storefront renders never call Meta.
create table instagram_connections (
  tenant_id uuid primary key references tenants(id),
  handle text check (handle ~ '^[A-Za-z0-9._]{1,30}$'),
  provider text not null default 'graph' check (provider in ('graph')),
  status text not null default 'not_connected' check (status in ('not_connected', 'connected', 'error')),
  ig_user_id text check (char_length(ig_user_id) <= 64),
  access_token_enc text,
  token_expires_at timestamptz,
  posts jsonb not null default '[]'::jsonb check (jsonb_typeof(posts) = 'array' and jsonb_array_length(posts) <= 24),
  last_synced_at timestamptz,
  last_error text check (char_length(last_error) <= 500),
  updated_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status <> 'connected' or (ig_user_id is not null and access_token_enc is not null))
);

select app.apply_conventions('{{APP_ROLE}}');

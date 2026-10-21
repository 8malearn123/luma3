-- ════════════════════════════════════════════════════════════════════════════
-- 0004 Tenant customers, consents, bookings, allocations, reviews, waitlist,
--      group sessions.
-- ════════════════════════════════════════════════════════════════════════════

-- The local relationship between a business and a person. A central LUMA user
-- may link to many tenant_customers (one per business); a walk-in customer can
-- exist without a LUMA account. Notes are private to the business.
create table tenant_customers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  user_id uuid references users(id),
  display_name text not null,
  phone text,
  email citext,
  private_notes text,
  tags text[] not null default '{}',
  preferences jsonb not null default '{}'::jsonb,
  source text not null default 'storefront' check (source in ('storefront', 'dashboard', 'walk_in', 'import')),
  first_visit_at timestamptz,
  last_visit_at timestamptz,
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id)
);
create unique index tenant_customers_user_uq on tenant_customers (tenant_id, user_id) where user_id is not null;
create index tenant_customers_phone_idx on tenant_customers (tenant_id, phone);

-- Consent history (append-only). Scope = one business (tenant_id) or the LUMA
-- platform itself (tenant_id null). The latest row per (subject, scope, channel,
-- purpose) is the effective state.
create table customer_consents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references tenants(id),
  user_id uuid references users(id),
  tenant_customer_id uuid,
  channel text not null check (channel in ('email', 'sms', 'whatsapp', 'push')),
  purpose text not null default 'marketing' check (purpose in ('marketing', 'waitlist', 'reminders')),
  granted boolean not null,
  source text not null check (source in ('signup', 'checkout', 'account', 'dashboard', 'unsubscribe_link', 'import')),
  recorded_by uuid references users(id),
  recorded_at timestamptz not null default now(),
  check (user_id is not null or tenant_customer_id is not null),
  foreign key (tenant_id, tenant_customer_id) references tenant_customers(tenant_id, id)
);
create index customer_consents_idx on customer_consents (tenant_id, tenant_customer_id, channel, purpose, recorded_at desc);

-- ── Bookings ─────────────────────────────────────────────────────────────────
create table bookings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  branch_id uuid not null,
  number text not null,
  tenant_customer_id uuid not null,
  customer_user_id uuid references users(id),
  status text not null check (status in (
    'draft', 'held', 'pending_approval', 'pending_payment', 'confirmed', 'checked_in', 'in_service',
    'completed', 'expired', 'cancelled', 'no_show')),
  -- Financial state is separate from service state.
  payment_status text not null default 'unpaid' check (payment_status in (
    'unpaid', 'deposit_paid', 'partially_paid', 'paid', 'refund_pending', 'partially_refunded', 'refunded')),
  source text not null check (source in ('storefront', 'dashboard', 'walk_in', 'waitlist', 'reschedule')),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  timezone text not null,
  subtotal_minor bigint not null check (subtotal_minor >= 0),
  discount_minor bigint not null default 0 check (discount_minor >= 0),
  tax_minor bigint not null default 0 check (tax_minor >= 0),
  total_minor bigint not null check (total_minor >= 0),
  deposit_due_minor bigint not null default 0 check (deposit_due_minor >= 0 and deposit_due_minor <= total_minor),
  paid_minor bigint not null default 0 check (paid_minor >= 0),
  refunded_minor bigint not null default 0 check (refunded_minor >= 0 and refunded_minor <= paid_minor),
  currency char(3) not null default 'SAR',
  -- Snapshots captured at booking time (terms, payment options and their reason).
  policy_snapshot jsonb not null default '{}'::jsonb,
  payment_terms jsonb not null default '{}'::jsonb,
  hold_expires_at timestamptz,
  customer_note text,
  internal_note text,
  coupon_id uuid,
  rescheduled_from_id uuid references bookings(id),
  rescheduled_to_id uuid references bookings(id),
  cancelled_at timestamptz,
  cancelled_by uuid references users(id),
  cancel_source text check (cancel_source in ('customer', 'business', 'system')),
  cancel_reason text,
  campaign_id uuid,
  attribution jsonb,
  created_by uuid references users(id),
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, number),
  check (ends_at > starts_at),
  foreign key (tenant_id, branch_id) references branches(tenant_id, id),
  foreign key (tenant_id, tenant_customer_id) references tenant_customers(tenant_id, id)
);
create index bookings_tenant_time_idx on bookings (tenant_id, starts_at);
create index bookings_customer_idx on bookings (customer_user_id, starts_at desc) where customer_user_id is not null;
create index bookings_hold_idx on bookings (hold_expires_at) where status in ('held', 'pending_payment');

create table booking_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  booking_id uuid not null,
  sequence int not null,
  service_id uuid not null,
  variant_id uuid,
  staff_id uuid not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  buffer_before_min int not null default 0,
  buffer_after_min int not null default 0,
  -- Snapshot: history must not be reconstructed from the current catalog.
  service_name_ar text,
  service_name_en text,
  staff_name text not null,
  duration_min int not null,
  unit_price_minor bigint not null check (unit_price_minor >= 0),
  addons jsonb not null default '[]'::jsonb,
  addons_price_minor bigint not null default 0 check (addons_price_minor >= 0),
  line_total_minor bigint not null check (line_total_minor >= 0),
  -- Actual execution timestamps (for real elapsed-time analytics).
  actual_started_at timestamptz,
  actual_ended_at timestamptz,
  materials_consumed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (booking_id, sequence),
  check (ends_at > starts_at),
  foreign key (tenant_id, booking_id) references bookings(tenant_id, id),
  foreign key (tenant_id, service_id) references services(tenant_id, id),
  foreign key (tenant_id, variant_id) references service_variants(tenant_id, id),
  foreign key (tenant_id, staff_id) references staff_profiles(tenant_id, id)
);
create index booking_items_staff_idx on booking_items (tenant_id, staff_id, starts_at);

-- Time allocations for people and resources. The exclusion constraints are the
-- final authority against double booking: two transactions can both believe a
-- slot is free, but only one INSERT can succeed.
-- Holds are allocations in state 'held' with an expiry. Expired holds are moved
-- to 'released' (in the same transaction, before allocating) so they never block.
create table booking_allocations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  booking_id uuid not null,
  booking_item_id uuid,
  group_session_id uuid,
  staff_id uuid,
  resource_id uuid,
  during tstzrange not null check (not isempty(during)),
  state text not null check (state in ('held', 'confirmed', 'released')),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  released_at timestamptz,
  check ((staff_id is null) <> (resource_id is null)),
  check (state <> 'held' or expires_at is not null),
  foreign key (tenant_id, booking_id) references bookings(tenant_id, id),
  foreign key (tenant_id, booking_item_id) references booking_items(tenant_id, id),
  foreign key (tenant_id, staff_id) references staff_profiles(tenant_id, id),
  foreign key (tenant_id, resource_id) references resources(tenant_id, id),
  constraint booking_allocations_staff_no_overlap exclude using gist (
    tenant_id with =, staff_id with =, during with &&
  ) where (state in ('held', 'confirmed') and staff_id is not null),
  constraint booking_allocations_resource_no_overlap exclude using gist (
    tenant_id with =, resource_id with =, during with &&
  ) where (state in ('held', 'confirmed') and resource_id is not null)
);
create index booking_allocations_booking_idx on booking_allocations (tenant_id, booking_id);
create index booking_allocations_expiry_idx on booking_allocations (expires_at) where state = 'held';

create table booking_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  booking_id uuid not null,
  from_status text,
  to_status text,
  kind text not null default 'transition',
  actor_user_id uuid references users(id),
  actor_role text,
  source text not null,
  reason text,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, booking_id) references bookings(tenant_id, id)
);
create index booking_events_idx on booking_events (tenant_id, booking_id, created_at);

-- Customer's own booking list across every business (central account view).
-- Returns only allowlisted fields; never other customers' data or private notes.
create or replace function app.customer_bookings(p_user uuid, p_limit int, p_before timestamptz)
returns table (id uuid, tenant_id uuid, tenant_slug text, tenant_name text, number text, status text, payment_status text,
               starts_at timestamptz, ends_at timestamptz, timezone text, total_minor bigint, currency char(3), items jsonb)
language sql stable security definer set search_path = public as $$
  select b.id, b.tenant_id, t.slug::text, t.name, b.number, b.status, b.payment_status, b.starts_at, b.ends_at, b.timezone,
         b.total_minor, b.currency,
         coalesce((select jsonb_agg(jsonb_build_object('service_name_ar', i.service_name_ar, 'service_name_en', i.service_name_en,
                   'staff_name', i.staff_name, 'starts_at', i.starts_at, 'ends_at', i.ends_at) order by i.sequence)
                   from booking_items i where i.booking_id = b.id), '[]'::jsonb)
  from bookings b join tenants t on t.id = b.tenant_id
  where b.customer_user_id = p_user and b.status not in ('draft')
    and (p_before is null or b.starts_at < p_before)
  order by b.starts_at desc
  limit least(p_limit, 100)
$$;

-- ── Reviews (eligible only for a completed visit; one per booking) ──────────
create table reviews (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  booking_id uuid not null,
  tenant_customer_id uuid not null,
  staff_id uuid,
  rating smallint not null check (rating between 1 and 5),
  comment text check (comment is null or length(comment) <= 2000),
  status text not null default 'published' check (status in ('published', 'hidden', 'flagged')),
  business_reply text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, booking_id),
  foreign key (tenant_id, booking_id) references bookings(tenant_id, id),
  foreign key (tenant_id, tenant_customer_id) references tenant_customers(tenant_id, id),
  foreign key (tenant_id, staff_id) references staff_profiles(tenant_id, id)
);

create or replace function app.review_requires_completed_visit() returns trigger
language plpgsql as $$
begin
  if not exists (select 1 from bookings b where b.id = new.booking_id and b.tenant_id = new.tenant_id and b.status = 'completed'
                 and b.tenant_customer_id = new.tenant_customer_id) then
    raise exception 'review requires a completed visit by this customer' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger reviews_eligibility before insert on reviews for each row execute function app.review_requires_completed_visit();

-- ── Group sessions (shared capacity) ─────────────────────────────────────────
create table group_sessions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  branch_id uuid not null,
  service_id uuid not null,
  staff_id uuid not null,
  resource_id uuid,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  capacity int not null check (capacity between 1 and 500),
  seats_taken int not null default 0,
  price_minor bigint not null check (price_minor >= 0),
  status text not null default 'scheduled' check (status in ('scheduled', 'cancelled', 'completed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  check (ends_at > starts_at),
  check (seats_taken >= 0 and seats_taken <= capacity),
  foreign key (tenant_id, branch_id) references branches(tenant_id, id),
  foreign key (tenant_id, service_id) references services(tenant_id, id),
  foreign key (tenant_id, staff_id) references staff_profiles(tenant_id, id),
  foreign key (tenant_id, resource_id) references resources(tenant_id, id)
);

alter table booking_allocations
  add constraint booking_allocations_group_fk foreign key (tenant_id, group_session_id) references group_sessions(tenant_id, id);

create table group_session_bookings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  group_session_id uuid not null,
  booking_id uuid not null,
  seats int not null default 1 check (seats between 1 and 20),
  status text not null default 'active' check (status in ('active', 'released')),
  created_at timestamptz not null default now(),
  unique (tenant_id, booking_id),
  foreign key (tenant_id, group_session_id) references group_sessions(tenant_id, id),
  foreign key (tenant_id, booking_id) references bookings(tenant_id, id)
);

-- ── Waitlist ─────────────────────────────────────────────────────────────────
create table waitlist_entries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  branch_id uuid not null,
  service_id uuid not null,
  staff_id uuid,
  tenant_customer_id uuid not null,
  customer_user_id uuid references users(id),
  desired_from date not null,
  desired_to date not null,
  -- [{weekday?:0-6, from:"HH:MM", to:"HH:MM"}]; empty = any time
  time_windows jsonb not null default '[]'::jsonb,
  notify_consent boolean not null default false,
  status text not null default 'active' check (status in ('active', 'offered', 'fulfilled', 'expired', 'cancelled')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  check (desired_to >= desired_from),
  foreign key (tenant_id, branch_id) references branches(tenant_id, id),
  foreign key (tenant_id, service_id) references services(tenant_id, id),
  foreign key (tenant_id, staff_id) references staff_profiles(tenant_id, id),
  foreign key (tenant_id, tenant_customer_id) references tenant_customers(tenant_id, id)
);

create table waitlist_offers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  waitlist_entry_id uuid not null,
  staff_id uuid not null,
  slot_start timestamptz not null,
  slot_end timestamptz not null,
  rank_basis jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined', 'expired', 'superseded')),
  expires_at timestamptz not null,
  booking_id uuid,
  token_hash bytea unique,
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  foreign key (tenant_id, waitlist_entry_id) references waitlist_entries(tenant_id, id),
  foreign key (tenant_id, staff_id) references staff_profiles(tenant_id, id),
  foreign key (tenant_id, booking_id) references bookings(tenant_id, id)
);
-- At most one live offer for the same opening, so one slot is never promised to many.
create unique index waitlist_offers_one_pending on waitlist_offers (tenant_id, staff_id, slot_start) where status = 'pending';

select app.apply_conventions('{{APP_ROLE}}');
select app.make_append_only('booking_events', '{{APP_ROLE}}');
select app.make_append_only('customer_consents', '{{APP_ROLE}}');
grant execute on function app.customer_bookings(uuid, int, timestamptz) to {{APP_ROLE}};

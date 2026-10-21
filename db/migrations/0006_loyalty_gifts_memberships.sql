-- ════════════════════════════════════════════════════════════════════════════
-- 0006 Loyalty (points ledger), rewards, coupon redemptions, gift cards,
--      memberships / prepaid packages with entitlement reservations.
-- Loyalty is tenant-scoped by default; platform-wide redemption is a separate
-- product decision and is not implemented.
-- ════════════════════════════════════════════════════════════════════════════

create table loyalty_programs (
  tenant_id uuid primary key references tenants(id),
  is_enabled boolean not null default false,
  -- Points earned per 1 SAR (100 minor units) of completed, paid service/product value.
  points_per_currency_unit numeric(8, 2) not null default 1 check (points_per_currency_unit >= 0),
  points_expiry_days int check (points_expiry_days is null or points_expiry_days between 30 and 1825),
  -- [{code, name_ar, name_en, min_lifetime_points}]
  tiers jsonb not null default '[]'::jsonb,
  reverse_on_refund boolean not null default true,
  version int not null default 1,
  updated_at timestamptz not null default now()
);

create table loyalty_accounts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  tenant_customer_id uuid not null,
  -- Cache of the ledger, updated in the same transaction as each entry.
  balance int not null default 0 check (balance >= 0),
  lifetime_earned int not null default 0 check (lifetime_earned >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, tenant_customer_id),
  foreign key (tenant_id, tenant_customer_id) references tenant_customers(tenant_id, id)
);

create table points_entries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  account_id uuid not null,
  kind text not null check (kind in ('earn', 'redeem', 'expire', 'reverse', 'adjust')),
  delta int not null check (delta <> 0),
  balance_after int not null check (balance_after >= 0),
  ref_type text not null,
  ref_id uuid,
  expires_at timestamptz,
  reason text,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  foreign key (tenant_id, account_id) references loyalty_accounts(tenant_id, id)
);
create unique index points_entries_once on points_entries (account_id, kind, ref_type, ref_id) where ref_id is not null;

create table rewards (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  name_ar text,
  name_en text,
  points_cost int not null check (points_cost > 0),
  kind text not null check (kind in ('fixed_discount', 'percent_discount')),
  value int not null check (value > 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  check (coalesce(name_ar, name_en) is not null)
);

create table reward_redemptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  account_id uuid not null,
  reward_id uuid not null,
  points int not null check (points > 0),
  coupon_id uuid,
  status text not null default 'issued' check (status in ('issued', 'used', 'reversed')),
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, idempotency_key),
  foreign key (tenant_id, account_id) references loyalty_accounts(tenant_id, id),
  foreign key (tenant_id, reward_id) references rewards(tenant_id, id),
  foreign key (tenant_id, coupon_id) references coupons(tenant_id, id)
);

create table coupon_redemptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  coupon_id uuid not null,
  tenant_customer_id uuid not null,
  booking_id uuid,
  order_id uuid,
  discount_minor bigint not null check (discount_minor >= 0),
  status text not null default 'applied' check (status in ('applied', 'released')),
  created_at timestamptz not null default now(),
  check (num_nonnulls(booking_id, order_id) = 1),
  foreign key (tenant_id, coupon_id) references coupons(tenant_id, id),
  foreign key (tenant_id, tenant_customer_id) references tenant_customers(tenant_id, id),
  foreign key (tenant_id, booking_id) references bookings(tenant_id, id),
  foreign key (tenant_id, order_id) references orders(tenant_id, id)
);
create unique index coupon_redemptions_booking_uq on coupon_redemptions (coupon_id, booking_id) where booking_id is not null;
create unique index coupon_redemptions_order_uq on coupon_redemptions (coupon_id, order_id) where order_id is not null;

-- ── Gift cards ───────────────────────────────────────────────────────────────
-- Codes are high-entropy; only a keyed hash and the last 4 characters are stored.
create table gift_cards (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  code_hash bytea not null unique,
  code_last4 text not null,
  initial_minor bigint not null check (initial_minor > 0),
  balance_minor bigint not null check (balance_minor >= 0),
  currency char(3) not null default 'SAR',
  status text not null default 'pending' check (status in ('pending', 'active', 'redeemed', 'expired', 'void')),
  template_key text not null default 'classic',
  purchaser_customer_id uuid,
  recipient_name text,
  recipient_contact text,
  message text check (message is null or length(message) <= 300),
  issued_by uuid references users(id),
  activated_at timestamptz,
  expires_at timestamptz,
  order_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  check (balance_minor <= initial_minor),
  foreign key (tenant_id, purchaser_customer_id) references tenant_customers(tenant_id, id),
  foreign key (tenant_id, order_id) references orders(tenant_id, id)
);

create table gift_card_entries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  gift_card_id uuid not null,
  kind text not null check (kind in ('issue', 'redeem', 'refund', 'expire', 'void', 'adjust')),
  delta_minor bigint not null,
  balance_after_minor bigint not null check (balance_after_minor >= 0),
  ref_type text,
  ref_id uuid,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  foreign key (tenant_id, gift_card_id) references gift_cards(tenant_id, id)
);
create unique index gift_card_entries_once on gift_card_entries (gift_card_id, kind, ref_type, ref_id) where ref_id is not null;

alter table payments add constraint payments_gift_card_fk foreign key (tenant_id, gift_card_id) references gift_cards(tenant_id, id);

-- ── Memberships / prepaid packages ───────────────────────────────────────────
create table membership_plans (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  name_ar text,
  name_en text,
  description_ar text,
  description_en text,
  price_minor bigint not null check (price_minor >= 0),
  validity_days int not null check (validity_days between 1 and 1095),
  is_active boolean not null default true,
  is_visible boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  check (coalesce(name_ar, name_en) is not null)
);

create table membership_plan_items (
  tenant_id uuid not null,
  plan_id uuid not null,
  service_id uuid not null,
  sessions int not null check (sessions between 1 and 500),
  primary key (tenant_id, plan_id, service_id),
  foreign key (tenant_id, plan_id) references membership_plans(tenant_id, id) on delete cascade,
  foreign key (tenant_id, service_id) references services(tenant_id, id)
);

create table customer_memberships (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  plan_id uuid not null,
  tenant_customer_id uuid not null,
  status text not null default 'pending_payment' check (status in ('pending_payment', 'active', 'expired', 'cancelled')),
  starts_at timestamptz,
  ends_at timestamptz,
  price_paid_minor bigint not null,
  plan_snapshot jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, plan_id) references membership_plans(tenant_id, id),
  foreign key (tenant_id, tenant_customer_id) references tenant_customers(tenant_id, id)
);

alter table payments add constraint payments_membership_fk foreign key (tenant_id, customer_membership_id) references customer_memberships(tenant_id, id);

create table membership_entitlements (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  membership_id uuid not null,
  service_id uuid not null,
  total int not null check (total > 0),
  used int not null default 0,
  reserved int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (membership_id, service_id),
  check (used >= 0 and reserved >= 0 and used + reserved <= total),
  foreign key (tenant_id, membership_id) references customer_memberships(tenant_id, id),
  foreign key (tenant_id, service_id) references services(tenant_id, id)
);

create table entitlement_reservations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  entitlement_id uuid not null,
  booking_item_id uuid not null,
  status text not null default 'reserved' check (status in ('reserved', 'consumed', 'released')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (booking_item_id),
  foreign key (tenant_id, entitlement_id) references membership_entitlements(tenant_id, id),
  foreign key (tenant_id, booking_item_id) references booking_items(tenant_id, id)
);

select app.apply_conventions('{{APP_ROLE}}');
select app.make_append_only('points_entries', '{{APP_ROLE}}');
select app.make_append_only('gift_card_entries', '{{APP_ROLE}}');

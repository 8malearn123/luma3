-- ════════════════════════════════════════════════════════════════════════════
-- 0630 Platform administration extensions (phase 2):
--   approved plan prices (data), founding-customer seats, plan promotions,
--   platform settings (maintenance, sign-ups, approvals, marketplace
--   verification), business approvals, referrals & marketers with a cash
--   balance ledger and withdrawals, settlement statements for the split-payment
--   model, and indexes for the cross-tenant activity feed.
-- See docs/PLATFORM_ADMIN.md.
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. Approved prices (VAT-inclusive, SAR, halalas) ────────────────────────
-- Monthly: Sanaa 199, Wahaj 399, Fareed 799. Yearly = two months free
-- (10 × monthly). Plans are data: only fills prices that were never configured,
-- so later edits by the LUMA owner in /platform/plans are never overwritten.
update plans set price_monthly_minor = 19900, price_yearly_minor = 199000, price_is_test = false where code = 'sanaa' and price_monthly_minor is null;
update plans set price_monthly_minor = 39900, price_yearly_minor = 399000, price_is_test = false where code = 'wahaj' and price_monthly_minor is null;
update plans set price_monthly_minor = 79900, price_yearly_minor = 799000, price_is_test = false where code = 'fareed' and price_monthly_minor is null;

-- ── 2. Plan promotions (time-limited % discount; by code or automatic) ──────
create table plan_promotions (
  id uuid primary key default gen_random_uuid(),
  -- NULL code = automatic offer (applied to every eligible new subscription).
  code citext unique check (code is null or code ~ '^[A-Za-z0-9_-]{3,32}$'),
  name_ar text not null check (length(name_ar) between 1 and 120),
  name_en text not null check (length(name_en) between 1 and 120),
  discount_bp int not null check (discount_bp between 1 and 10000),
  -- Empty array = every plan / every billing cycle.
  plan_codes text[] not null default '{}',
  billing_cycles text[] not null default '{}' check (billing_cycles <@ array['monthly', 'yearly']::text[]),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  -- Number of paid billing cycles the discount applies to; NULL = while the subscription lasts.
  duration_cycles int check (duration_cycles is null or duration_cycles between 1 and 120),
  max_redemptions int check (max_redemptions is null or max_redemptions >= 1),
  redemptions int not null default 0 check (redemptions >= 0),
  status text not null default 'active' check (status in ('active', 'disabled')),
  created_by uuid references users(id),
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at),
  check (max_redemptions is null or redemptions <= max_redemptions)
);

-- ── 3. Subscriptions: founding seat + applied promotion ─────────────────────
-- A founding seat is assigned once (first invoice or first activation) to the
-- first N paying subscribers (platform setting founding_seats_total, default
-- 100). The discount lasts while the subscription stays current; once it is
-- cancelled or expired the discount is lost for good (founding_lost_at), and
-- the seat is not handed to anyone else.
alter table subscriptions add column founding_number int check (founding_number is null or founding_number >= 1);
alter table subscriptions add column founding_discount_bp int check (founding_discount_bp is null or founding_discount_bp between 0 and 10000);
alter table subscriptions add column founding_lost_at timestamptz;
create unique index subscriptions_founding_number_uq on subscriptions (founding_number) where founding_number is not null;
alter table subscriptions add column promotion_id uuid references plan_promotions(id);
alter table subscriptions add column promotion_discount_bp int check (promotion_discount_bp is null or promotion_discount_bp between 0 and 10000);
-- NULL with a promotion = applies while subscribed; 0 = used up.
alter table subscriptions add column promotion_cycles_remaining int check (promotion_cycles_remaining is null or promotion_cycles_remaining >= 0);

create or replace function app.subscription_founding_lost() returns trigger
language plpgsql as $$
begin
  if new.founding_number is not null and new.founding_lost_at is null
     and new.status in ('cancelled', 'expired') and old.status is distinct from new.status then
    new.founding_lost_at := now();
  end if;
  return new;
end $$;
create trigger subscription_founding_lost before update of status on subscriptions
  for each row execute function app.subscription_founding_lost();

-- Platform invoices: list price and the discounts applied.
alter table platform_invoices add column list_amount_minor bigint check (list_amount_minor is null or list_amount_minor >= 0);
alter table platform_invoices add column discount_minor bigint not null default 0 check (discount_minor >= 0);
alter table platform_invoices add column discount_detail jsonb;

-- ── 4. Platform settings (central key/value; defaults mirrored in code) ─────
-- Keys and types: src/shared/platform-settings.ts. Notably
-- `marketplace_requires_verification` (boolean, default true) is read by the
-- LUMA marketplace before listing a business.
create table platform_settings (
  key text primary key check (key ~ '^[a-z0-9_.]{2,64}$'),
  value jsonb not null,
  updated_by uuid references users(id),
  updated_at timestamptz not null default now()
);
insert into platform_settings (key, value) values
  ('platform_name', '"LUMA"'),
  ('maintenance_mode', 'false'),
  ('maintenance_message_ar', '"نعمل على تحسينات في لوحة التحكم. متجركِ والحجوزات تعمل كالمعتاد."'),
  ('maintenance_message_en', '"We are improving the dashboard. Your storefront and bookings keep working."'),
  ('allow_signups', 'true'),
  ('require_business_approval', 'false'),
  ('marketplace_requires_verification', 'true'),
  ('founding_enabled', 'true'),
  ('founding_seats_total', '100'),
  ('founding_discount_bp', '3000'),
  ('referral_default_rate_bp', '1000'),
  ('referral_min_withdrawal_minor', '10000')
on conflict (key) do nothing;

-- ── 5. Business approval (when require_business_approval is on) ────────────
create table tenant_approvals (
  tenant_id uuid primary key references tenants(id),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  reason text check (reason is null or length(reason) <= 500),
  decided_by uuid references users(id),
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status = 'pending' or decided_at is not null)
);
create index tenant_approvals_pending_idx on tenant_approvals (created_at) where status = 'pending';

-- ── 6. Referrals & marketers ────────────────────────────────────────────────
-- A referrer is either a LUMA marketer (affiliate, tenant_id NULL: visible in
-- system scope only) or a business (tenant_id set: RLS lets that business read
-- its own row). Rewards are a withdrawable cash balance kept in an append-only
-- ledger; withdrawals hold the amount when requested and release it if rejected.
create table referrers (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('marketer', 'business')),
  tenant_id uuid references tenants(id),
  code citext not null unique check (code ~ '^[A-Za-z0-9_-]{4,32}$'),
  display_name text not null check (length(display_name) between 1 and 120),
  contact_email citext,
  contact_phone text check (contact_phone is null or contact_phone ~ '^\+[1-9][0-9]{7,14}$'),
  user_id uuid references users(id),
  -- NULL = the global default (platform setting referral_default_rate_bp).
  rate_bp int check (rate_bp is null or rate_bp between 0 and 10000),
  iban text check (iban is null or iban ~ '^SA[0-9]{22}$'),
  status text not null default 'active' check (status in ('active', 'suspended')),
  created_by uuid references users(id),
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((kind = 'business') = (tenant_id is not null))
);
create unique index referrers_one_per_business on referrers (tenant_id) where tenant_id is not null;

-- Central (no tenant_id): the referrer and the referred business are different
-- tenants. Read only through domain functions that filter by referrer; the
-- referred business is shown by its name snapshot and status only.
create table referrals (
  id uuid primary key default gen_random_uuid(),
  referrer_id uuid not null references referrers(id),
  referred_tenant_id uuid not null unique references tenants(id),
  referred_name text not null,
  channel text not null default 'code' check (channel in ('code', 'link')),
  status text not null default 'pending' check (status in ('pending', 'rewarded', 'void')),
  rate_bp int,
  reward_minor bigint check (reward_minor is null or reward_minor >= 0),
  invoice_id uuid references platform_invoices(id),
  rewarded_at timestamptz,
  created_at timestamptz not null default now(),
  check (status <> 'rewarded' or (reward_minor is not null and rewarded_at is not null))
);
create index referrals_referrer_idx on referrals (referrer_id, created_at desc);

create table referral_withdrawals (
  id uuid primary key default gen_random_uuid(),
  referrer_id uuid not null references referrers(id),
  amount_minor bigint not null check (amount_minor > 0),
  currency char(3) not null default 'SAR',
  iban text not null check (iban ~ '^SA[0-9]{22}$'),
  account_name text not null check (length(account_name) between 2 and 120),
  status text not null default 'requested' check (status in ('requested', 'approved', 'rejected', 'paid')),
  requested_by uuid references users(id),
  decided_by uuid references users(id),
  decided_at timestamptz,
  reject_reason text check (reject_reason is null or length(reject_reason) <= 300),
  paid_at timestamptz,
  paid_reference text check (paid_reference is null or length(paid_reference) <= 120),
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status <> 'paid' or paid_at is not null),
  check (status <> 'rejected' or reject_reason is not null)
);
create index referral_withdrawals_status_idx on referral_withdrawals (status, created_at);

-- Balance = sum(amount_minor) per referrer. Rewards are credited once per referral.
create table referral_ledger (
  id uuid primary key default gen_random_uuid(),
  referrer_id uuid not null references referrers(id),
  kind text not null check (kind in ('reward', 'withdrawal_hold', 'withdrawal_release', 'adjustment')),
  amount_minor bigint not null check (amount_minor <> 0),
  currency char(3) not null default 'SAR',
  referral_id uuid references referrals(id),
  withdrawal_id uuid references referral_withdrawals(id),
  note text check (note is null or length(note) <= 300),
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  check (kind <> 'reward' or (referral_id is not null and amount_minor > 0)),
  check (kind not in ('withdrawal_hold', 'withdrawal_release') or withdrawal_id is not null)
);
create unique index referral_ledger_one_reward on referral_ledger (referral_id) where kind = 'reward';
create unique index referral_ledger_one_hold on referral_ledger (withdrawal_id, kind) where withdrawal_id is not null;
create index referral_ledger_referrer_idx on referral_ledger (referrer_id, created_at desc);

-- ── 7. Settlements (split payments: the intermediary pays providers directly)
create table settlement_statements (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  period_start date not null,
  period_end date not null,
  currency char(3) not null default 'SAR',
  gross_minor bigint not null check (gross_minor >= 0),
  refunds_minor bigint not null default 0 check (refunds_minor >= 0),
  fee_minor bigint not null default 0 check (fee_minor >= 0),
  net_minor bigint not null,
  payments_count int not null default 0,
  fee_source text not null,
  status text not null default 'simulated' check (status in ('simulated', 'settled')),
  settled_at timestamptz,
  settled_by uuid references users(id),
  settlement_reference text check (settlement_reference is null or length(settlement_reference) <= 120),
  generated_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, period_start, period_end),
  check (period_end >= period_start),
  check (net_minor = gross_minor - refunds_minor - fee_minor),
  check (status <> 'settled' or settled_at is not null)
);
create index settlement_statements_period_idx on settlement_statements (period_start desc, status);

-- ── 8. Cross-tenant activity feed / platform reports ────────────────────────
create index if not exists bookings_created_idx on bookings (created_at desc);
create index if not exists payments_captured_idx on payments (captured_at desc) where status = 'captured';
create index if not exists reviews_created_idx on reviews (created_at desc);
create index if not exists tenants_created_idx on tenants (created_at desc);
create index if not exists orders_created_idx on orders (created_at desc);

select app.apply_conventions('{{APP_ROLE}}');
select app.make_append_only('referral_ledger', '{{APP_ROLE}}');

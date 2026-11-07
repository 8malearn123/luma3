-- 0600 Payroll: base salaries, the business's service-commission policy, tips,
-- bonuses, deductions and advances, and a monthly close that freezes one
-- payslip per staff member.
--
-- Commission is earned on SERVICES only. commission_entries reference booking
-- items, and nothing in this module creates a commission from a product sale.
--
-- Payroll journal (double entry, see domains/finance/journal.ts):
--   Tip recorded        Dr cash_on_hand|provider_clearing   Cr tips_payable
--   Advance paid        Dr staff_advances                   Cr cash_on_hand
--   Month closed        Dr salaries_expense (base + bonus − deduction)
--                       Dr commissions_payable (net commission)
--                       Dr tips_payable (tips)
--                       Cr staff_advances (advances recovered)
--                       Cr payroll_payable (net pay)
--   Payslip paid        Dr payroll_payable                  Cr cash_on_hand

alter table financial_entries drop constraint financial_entries_account_check;
alter table financial_entries add constraint financial_entries_account_check check (account in (
  'cash_on_hand', 'provider_clearing', 'customer_deposits', 'accounts_receivable',
  'service_revenue', 'product_revenue', 'gift_card_liability', 'membership_liability',
  'discounts', 'refunds', 'provider_fees', 'tax_payable', 'cogs', 'inventory', 'material_costs',
  'commissions_expense', 'commissions_payable', 'operating_expenses', 'owner_equity',
  'salaries_expense', 'payroll_payable', 'staff_advances', 'tips_payable'));

-- Business policy: the owner switches service commission and tips on or off.
alter table tenant_settings add column service_commission_enabled boolean not null default true;
alter table tenant_settings add column tips_enabled boolean not null default true;

-- Per-service switch. The rate itself is a service-level commission rule
-- (commission_rules with service_id and no staff_id), so rates keep their
-- effective dates and are snapshotted on every commission entry. A service
-- switched off earns no commission for anyone, whatever other rules say.
create table service_commission_settings (
  tenant_id uuid not null references tenants(id),
  service_id uuid not null,
  commission_enabled boolean not null default true,
  updated_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, service_id),
  foreign key (tenant_id, service_id) references services(tenant_id, id)
);

-- Monthly base salary per staff member (0 = commission/tips only).
create table staff_pay_profiles (
  tenant_id uuid not null references tenants(id),
  staff_id uuid not null,
  base_salary_minor bigint not null default 0 check (base_salary_minor between 0 and 100000000000),
  updated_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, staff_id),
  foreign key (tenant_id, staff_id) references staff_profiles(tenant_id, id)
);

-- Bonuses, deductions, advances and tips. Never deleted: a mistake is voided
-- with a reason, and an entry already settled in a closed month cannot be voided.
create table payroll_entries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  staff_id uuid not null,
  kind text not null check (kind in ('bonus', 'deduction', 'advance', 'tip')),
  amount_minor bigint not null check (amount_minor > 0 and amount_minor <= 100000000000),
  currency char(3) not null default 'SAR',
  effective_on date not null,
  note text check (char_length(note) <= 500),
  booking_id uuid,
  method text check (method in ('cash', 'pos_terminal')),
  voided_at timestamptz,
  voided_by uuid references users(id),
  void_reason text,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  check (voided_at is null or void_reason is not null),
  check ((kind = 'tip') = (method is not null)),
  check (booking_id is null or kind = 'tip'),
  foreign key (tenant_id, staff_id) references staff_profiles(tenant_id, id),
  foreign key (tenant_id, booking_id) references bookings(tenant_id, id)
);
create index payroll_entries_period_idx on payroll_entries (tenant_id, effective_on);
create index payroll_entries_staff_idx on payroll_entries (tenant_id, staff_id, effective_on);

-- One closed run per business and month; months close in order.
create table payroll_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  period_month date not null check (extract(day from period_month) = 1),
  currency char(3) not null default 'SAR',
  staff_count int not null,
  base_minor bigint not null,
  commission_minor bigint not null,
  tips_minor bigint not null,
  bonus_minor bigint not null,
  deduction_minor bigint not null,
  advance_minor bigint not null,
  net_minor bigint not null,
  closed_by uuid references users(id),
  closed_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, period_month)
);

-- Frozen payslip: amounts are copied at close and never change.
create table payroll_slips (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  run_id uuid not null,
  staff_id uuid not null,
  number text not null,
  staff_name text not null,
  base_minor bigint not null,
  commission_minor bigint not null,
  commission_count int not null,
  tips_minor bigint not null,
  bonus_minor bigint not null,
  deduction_minor bigint not null,
  advance_minor bigint not null,
  net_minor bigint not null,
  lines jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (run_id, staff_id),
  unique (tenant_id, number),
  check (net_minor = base_minor + commission_minor + tips_minor + bonus_minor - deduction_minor - advance_minor),
  foreign key (tenant_id, run_id) references payroll_runs(tenant_id, id),
  foreign key (tenant_id, staff_id) references staff_profiles(tenant_id, id)
);

-- Payout of a payslip (once).
create table payroll_slip_payments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  slip_id uuid not null unique,
  amount_minor bigint not null check (amount_minor > 0),
  reference text check (char_length(reference) <= 80),
  paid_by uuid references users(id),
  paid_at timestamptz not null default now(),
  foreign key (tenant_id, slip_id) references payroll_slips(tenant_id, id)
);

-- Which commission entries and payroll entries a run settled. The primary key
-- makes it impossible to pay the same item twice, even under concurrent closes.
create table payroll_settled_items (
  tenant_id uuid not null,
  run_id uuid not null,
  source_type text not null check (source_type in ('commission', 'entry')),
  source_id uuid not null,
  primary key (source_type, source_id),
  foreign key (tenant_id, run_id) references payroll_runs(tenant_id, id)
);
create index payroll_settled_items_run_idx on payroll_settled_items (run_id);

-- Only the void columns of a payroll entry may change, and only before it is settled.
create or replace function app.payroll_entry_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'payroll entries are never deleted; void them instead' using errcode = '42501';
  end if;
  if (new.tenant_id, new.staff_id, new.kind, new.amount_minor, new.currency, new.effective_on, new.booking_id, new.method, new.created_by, new.created_at)
     is distinct from (old.tenant_id, old.staff_id, old.kind, old.amount_minor, old.currency, old.effective_on, old.booking_id, old.method, old.created_by, old.created_at) then
    raise exception 'payroll entry amounts are immutable' using errcode = '23514';
  end if;
  if old.voided_at is not null then
    raise exception 'payroll entry already void' using errcode = '23514';
  end if;
  if new.voided_at is not null and exists (select 1 from payroll_settled_items s where s.source_type = 'entry' and s.source_id = new.id) then
    raise exception 'payroll entry is settled in a closed month' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger payroll_entry_guard before update or delete on payroll_entries
  for each row execute function app.payroll_entry_guard();

select app.apply_conventions('{{APP_ROLE}}');
select app.make_append_only('payroll_runs', '{{APP_ROLE}}');
select app.make_append_only('payroll_slips', '{{APP_ROLE}}');
select app.make_append_only('payroll_slip_payments', '{{APP_ROLE}}');
select app.make_append_only('payroll_settled_items', '{{APP_ROLE}}');

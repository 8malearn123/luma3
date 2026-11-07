-- 0600 Payroll: base salaries (pro-rated by employment dates), commission on
-- services and on products decided by the business (a rate per category with
-- optional monthly sales tiers), tips, bonuses, deductions, advances repaid in
-- instalments, a bank account in the journal, and a monthly close that freezes
-- one payslip per staff member.
--
-- Payroll journal (double entry, see domains/finance/journal.ts):
--   Tip recorded        Dr cash_on_hand|provider_clearing   Cr tips_payable
--   Advance paid        Dr staff_advances                   Cr cash_on_hand|bank
--   Month closed        Dr salaries_expense (base + bonus − deduction)
--                       Dr commissions_expense (service + product commission)
--                       Dr tips_payable (tips)
--                       Cr staff_advances (instalments recovered)
--                       Cr payroll_payable (net pay)
--   Payslip paid        Dr payroll_payable                  Cr cash_on_hand|bank

alter table financial_entries drop constraint financial_entries_account_check;
alter table financial_entries add constraint financial_entries_account_check check (account in (
  'cash_on_hand', 'bank', 'provider_clearing', 'customer_deposits', 'accounts_receivable',
  'service_revenue', 'product_revenue', 'gift_card_liability', 'membership_liability',
  'discounts', 'refunds', 'provider_fees', 'tax_payable', 'cogs', 'inventory', 'material_costs',
  'commissions_expense', 'commissions_payable', 'operating_expenses', 'owner_equity',
  'salaries_expense', 'payroll_payable', 'staff_advances', 'tips_payable'));

alter table tenant_settings add column tips_enabled boolean not null default true;

-- Commission policy per category. Both categories start switched off; the
-- business switches each on and sets its rate. Tiers are optional:
-- [{"threshold_minor": 1000000, "rate_bp": 1500}, …] ascending. The highest
-- tier whose threshold the staff member's monthly sales in that category
-- reached sets the rate for ALL her sales of that category in the month.
create table commission_policies (
  tenant_id uuid not null references tenants(id),
  category text not null check (category in ('services', 'products')),
  enabled boolean not null default false,
  rate_bp int not null default 0 check (rate_bp between 0 and 10000),
  tiers jsonb not null default '[]'::jsonb check (jsonb_typeof(tiers) = 'array' and jsonb_array_length(tiers) <= 10),
  updated_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, category)
);

-- Who sold a product order (product commission goes to her).
alter table orders add column sold_by_staff_id uuid;
alter table orders add constraint orders_sold_by_fk foreign key (tenant_id, sold_by_staff_id) references staff_profiles(tenant_id, id);

-- Monthly base salary and employment dates (salary is pro-rated by calendar
-- days employed in the month).
create table staff_pay_profiles (
  tenant_id uuid not null references tenants(id),
  staff_id uuid not null,
  base_salary_minor bigint not null default 0 check (base_salary_minor between 0 and 100000000000),
  employment_start date,
  employment_end date,
  updated_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, staff_id),
  check (employment_end is null or employment_start is null or employment_end >= employment_start),
  foreign key (tenant_id, staff_id) references staff_profiles(tenant_id, id)
);

-- Bonuses, deductions, advances and tips. Never deleted: a mistake is voided
-- with a reason, and an entry already settled (even partly) cannot be voided.
create table payroll_entries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  staff_id uuid not null,
  kind text not null check (kind in ('bonus', 'deduction', 'advance', 'tip')),
  amount_minor bigint not null check (amount_minor > 0 and amount_minor <= 100000000000),
  currency char(3) not null default 'SAR',
  effective_on date not null,
  installments int not null default 1 check (installments between 1 and 36),
  note text check (char_length(note) <= 500),
  booking_id uuid,
  method text check (method in ('cash', 'pos_terminal', 'bank_transfer')),
  voided_at timestamptz,
  voided_by uuid references users(id),
  void_reason text,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  check (voided_at is null or void_reason is not null),
  check (case kind when 'tip' then method in ('cash', 'pos_terminal')
                   when 'advance' then method in ('cash', 'bank_transfer')
                   else method is null end),
  check (installments = 1 or kind = 'advance'),
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

-- Frozen payslip: amounts and the rates used are copied at close and never change.
create table payroll_slips (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  run_id uuid not null,
  staff_id uuid not null,
  number text not null,
  staff_name text not null,
  base_full_minor bigint not null,
  days_employed int not null,
  days_in_month int not null,
  base_minor bigint not null,
  service_sales_minor bigint not null,
  service_count int not null,
  service_rate_bp int not null,
  service_commission_minor bigint not null,
  product_sales_minor bigint not null,
  product_count int not null,
  product_rate_bp int not null,
  product_commission_minor bigint not null,
  commission_minor bigint not null,
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
  check (commission_minor = service_commission_minor + product_commission_minor),
  check (net_minor = base_minor + commission_minor + tips_minor + bonus_minor - deduction_minor - advance_minor),
  foreign key (tenant_id, run_id) references payroll_runs(tenant_id, id),
  foreign key (tenant_id, staff_id) references staff_profiles(tenant_id, id)
);

-- Payout of a payslip (once), from cash or the bank.
create table payroll_slip_payments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  slip_id uuid not null unique,
  amount_minor bigint not null check (amount_minor > 0),
  method text not null check (method in ('cash', 'bank_transfer')),
  reference text check (char_length(reference) <= 80),
  paid_by uuid references users(id),
  paid_at timestamptz not null default now(),
  foreign key (tenant_id, slip_id) references payroll_slips(tenant_id, id)
);

-- What each run settled: booking items (service sales), order items (product
-- sales), payroll entries, and advance instalments (part = instalment index).
-- The primary key makes it impossible to pay anything twice.
create table payroll_settled_items (
  tenant_id uuid not null,
  run_id uuid not null,
  source_type text not null check (source_type in ('booking_item', 'order_item', 'entry', 'advance_installment')),
  source_id uuid not null,
  part int not null default 0,
  amount_minor bigint not null default 0,
  primary key (source_type, source_id, part),
  foreign key (tenant_id, run_id) references payroll_runs(tenant_id, id)
);
create index payroll_settled_items_run_idx on payroll_settled_items (run_id);

-- Only the void columns of a payroll entry may change, and only before any part is settled.
create or replace function app.payroll_entry_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'payroll entries are never deleted; void them instead' using errcode = '42501';
  end if;
  if (new.tenant_id, new.staff_id, new.kind, new.amount_minor, new.currency, new.effective_on, new.installments, new.booking_id, new.method, new.created_by, new.created_at)
     is distinct from (old.tenant_id, old.staff_id, old.kind, old.amount_minor, old.currency, old.effective_on, old.installments, old.booking_id, old.method, old.created_by, old.created_at) then
    raise exception 'payroll entry amounts are immutable' using errcode = '23514';
  end if;
  if old.voided_at is not null then
    raise exception 'payroll entry already void' using errcode = '23514';
  end if;
  if new.voided_at is not null and exists (select 1 from payroll_settled_items s where s.source_type in ('entry', 'advance_installment') and s.source_id = new.id) then
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

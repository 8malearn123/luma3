-- 0610 HR: annual leave balance (monthly accrual, carry-over, owner
-- adjustments), approval chains with custom request types, lateness/absence
-- deduction suggestions approved in payroll, booking reroutes when leave is
-- approved, the owner-only staff file with documents and expiry alerts, and
-- per-staff commission overrides.

-- New leave types used by the seeded request types.
alter table leave_requests drop constraint leave_requests_leave_type_check;
alter table leave_requests add constraint leave_requests_leave_type_check
  check (leave_type in ('annual', 'sick', 'personal', 'other', 'emergency', 'unpaid'));

-- Business HR settings (one row per business, created on first use).
create table hr_settings (
  tenant_id uuid primary key references tenants(id),
  -- Minutes after the scheduled start before a clock-in counts as late.
  grace_minutes int not null default 10 check (grace_minutes between 0 and 240),
  -- What happens when an annual leave request exceeds the balance.
  leave_balance_policy text not null default 'block' check (leave_balance_policy in ('block', 'warn')),
  -- Produce lateness/absence deduction suggestions from attendance.
  attendance_deductions boolean not null default true,
  updated_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Leave ledger: days taken (approved leave) and owner adjustments. Accrual is
-- computed from the hire date, never stored. Append-only.
create table leave_ledger (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  staff_id uuid not null,
  bucket text not null check (bucket in ('annual', 'sick')),
  kind text not null check (kind in ('taken', 'adjustment')),
  days numeric(7, 2) not null check (days <> 0 and abs(days) <= 1000),
  leave_request_id uuid,
  note text check (char_length(note) <= 500),
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  check (kind = 'adjustment' or (leave_request_id is not null and days < 0)),
  check (kind = 'taken' or note is not null),
  foreign key (tenant_id, staff_id) references staff_profiles(tenant_id, id),
  foreign key (tenant_id, leave_request_id) references leave_requests(tenant_id, id)
);
create index leave_ledger_staff_idx on leave_ledger (tenant_id, staff_id, created_at);
create unique index leave_ledger_taken_uq on leave_ledger (leave_request_id, bucket) where kind = 'taken';

-- Request types: seeded per business on first use (annual, sick, emergency and
-- unpaid leave; advance; salary certificate; experience letter) plus custom
-- types. approval_chain is an ordered array of roles, e.g. ["manager","owner"].
-- fields: [{key, label_ar, label_en, type: text|number|date|select, required, options}].
create table hr_request_types (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  code text not null check (code ~ '^[a-z0-9_]{2,40}$'),
  kind text not null check (kind in ('leave', 'advance', 'letter', 'other')),
  leave_type text check (leave_type in ('annual', 'sick', 'emergency', 'unpaid')),
  name_ar text not null check (char_length(name_ar) between 1 and 80),
  name_en text check (char_length(name_en) <= 80),
  approval_chain jsonb not null default '["owner"]'::jsonb
    check (jsonb_typeof(approval_chain) = 'array' and jsonb_array_length(approval_chain) between 1 and 5),
  fields jsonb not null default '[]'::jsonb check (jsonb_typeof(fields) = 'array' and jsonb_array_length(fields) <= 15),
  is_system boolean not null default false,
  is_active boolean not null default true,
  sort int not null default 0,
  updated_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, code),
  check ((kind = 'leave') = (leave_type is not null))
);

-- A staff request moving through its approval chain (snapshotted at submission).
create table hr_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  type_id uuid not null,
  staff_id uuid not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  current_step int not null default 0 check (current_step >= 0),
  approval_chain jsonb not null check (jsonb_typeof(approval_chain) = 'array' and jsonb_array_length(approval_chain) between 1 and 5),
  field_values jsonb not null default '{}'::jsonb,
  -- Leave
  starts_on date,
  ends_on date,
  leave_days numeric(7, 2),
  leave_request_id uuid unique,
  balance_warning boolean not null default false,
  -- Advance
  amount_minor bigint check (amount_minor > 0 and amount_minor <= 100000000000),
  installments int check (installments between 1 and 36),
  payroll_entry_id uuid,
  note text check (char_length(note) <= 1000),
  requested_by uuid references users(id),
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  check (ends_on is null or starts_on is null or ends_on >= starts_on),
  foreign key (tenant_id, type_id) references hr_request_types(tenant_id, id),
  foreign key (tenant_id, staff_id) references staff_profiles(tenant_id, id),
  foreign key (tenant_id, leave_request_id) references leave_requests(tenant_id, id),
  foreign key (tenant_id, payroll_entry_id) references payroll_entries(tenant_id, id)
);
create index hr_requests_status_idx on hr_requests (tenant_id, status, created_at desc);
create index hr_requests_staff_idx on hr_requests (tenant_id, staff_id, created_at desc);

-- Full history of every request: submitted, each step's decision, cancellation. Append-only.
create table hr_request_actions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  request_id uuid not null,
  step int not null,
  role text,
  action text not null check (action in ('submitted', 'approved', 'rejected', 'cancelled')),
  note text check (char_length(note) <= 1000),
  data jsonb not null default '{}'::jsonb,
  actor_user_id uuid references users(id),
  created_at timestamptz not null default now(),
  foreign key (tenant_id, request_id) references hr_requests(tenant_id, id)
);
create index hr_request_actions_idx on hr_request_actions (request_id, created_at);

-- Deduction suggestions (lateness, absence, unpaid leave). The owner approves
-- or rejects them in payroll; an approved one becomes a payroll deduction.
create table payroll_deduction_suggestions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  staff_id uuid not null,
  source text not null check (source in ('lateness', 'absence', 'unpaid_leave')),
  on_date date not null,
  minutes int check (minutes >= 0),
  days numeric(7, 2),
  amount_minor bigint not null check (amount_minor > 0 and amount_minor <= 100000000000),
  basis jsonb not null default '{}'::jsonb,
  dedupe_key text not null check (char_length(dedupe_key) <= 200),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  hr_request_id uuid,
  payroll_entry_id uuid,
  decided_by uuid references users(id),
  decided_at timestamptz,
  decision_note text check (char_length(decision_note) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, dedupe_key),
  check ((status = 'approved') = (payroll_entry_id is not null)),
  foreign key (tenant_id, staff_id) references staff_profiles(tenant_id, id),
  foreign key (tenant_id, hr_request_id) references hr_requests(tenant_id, id),
  foreign key (tenant_id, payroll_entry_id) references payroll_entries(tenant_id, id)
);
create index payroll_deduction_suggestions_idx on payroll_deduction_suggestions (tenant_id, status, on_date);

-- What was done with each booking affected by an approved leave. Append-only.
create table booking_reroutes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  leave_request_id uuid,
  booking_id uuid not null,
  action text not null check (action in ('reassigned', 'rescheduled', 'cancelled')),
  from_staff_id uuid,
  to_staff_id uuid,
  from_starts_at timestamptz,
  to_starts_at timestamptz,
  note text check (char_length(note) <= 500),
  actor_user_id uuid references users(id),
  created_at timestamptz not null default now(),
  foreign key (tenant_id, leave_request_id) references leave_requests(tenant_id, id),
  foreign key (tenant_id, booking_id) references bookings(tenant_id, id),
  foreign key (tenant_id, from_staff_id) references staff_profiles(tenant_id, id),
  foreign key (tenant_id, to_staff_id) references staff_profiles(tenant_id, id)
);
create index booking_reroutes_leave_idx on booking_reroutes (tenant_id, leave_request_id);

-- Staff file: visible to the owner only. The hire date is
-- staff_pay_profiles.employment_start. The ID number is returned masked; a
-- reveal is audited.
create table staff_files (
  tenant_id uuid not null references tenants(id),
  staff_id uuid not null,
  employee_number text check (char_length(employee_number) between 1 and 40),
  nationality text check (char_length(nationality) <= 60),
  residence text check (char_length(residence) <= 200),
  id_type text check (id_type in ('national_id', 'iqama', 'border_number')),
  id_number text check (id_number ~ '^[A-Za-z0-9-]{4,30}$'),
  id_expiry date,
  admin_notes text check (char_length(admin_notes) <= 4000),
  updated_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, staff_id),
  foreign key (tenant_id, staff_id) references staff_profiles(tenant_id, id)
);
create unique index staff_files_employee_number_uq on staff_files (tenant_id, employee_number) where employee_number is not null;

-- Private documents of a staff member (stored outside the public media path).
create table staff_documents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  staff_id uuid not null,
  title text not null check (char_length(title) between 1 and 120),
  storage_key text not null unique,
  mime text not null check (mime in ('application/pdf', 'image/webp')),
  bytes int not null check (bytes > 0 and bytes <= 10485760),
  expires_on date,
  uploaded_by uuid references users(id),
  deleted_at timestamptz,
  deleted_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, staff_id) references staff_profiles(tenant_id, id)
);
create index staff_documents_staff_idx on staff_documents (tenant_id, staff_id);
create index staff_documents_expiry_idx on staff_documents (expires_on) where deleted_at is null and expires_on is not null;

-- Per-staff commission override: replaces the business policy of that
-- category for this staff member. Same shape as commission_policies.
create table staff_commission_overrides (
  tenant_id uuid not null references tenants(id),
  staff_id uuid not null,
  category text not null check (category in ('services', 'products')),
  enabled boolean not null default true,
  rate_bp int not null default 0 check (rate_bp between 0 and 10000),
  tiers jsonb not null default '[]'::jsonb check (jsonb_typeof(tiers) = 'array' and jsonb_array_length(tiers) <= 10),
  updated_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, staff_id, category),
  foreign key (tenant_id, staff_id) references staff_profiles(tenant_id, id)
);

select app.apply_conventions('{{APP_ROLE}}');
select app.make_append_only('leave_ledger', '{{APP_ROLE}}');
select app.make_append_only('hr_request_actions', '{{APP_ROLE}}');
select app.make_append_only('booking_reroutes', '{{APP_ROLE}}');

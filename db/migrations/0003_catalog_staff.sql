-- ════════════════════════════════════════════════════════════════════════════
-- 0003 Assets, catalog (categories, services, variants, add-ons, packages),
--      staff profiles, schedules, leave, attendance, resources.
--
-- Cross-tenant references are impossible by construction: child tables carry
-- tenant_id and reference parents through composite (tenant_id, id) keys.
-- ════════════════════════════════════════════════════════════════════════════

create table assets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references tenants(id),     -- NULL = platform asset (templates)
  kind text not null check (kind in ('image', 'document', 'evidence')),
  purpose text not null check (purpose in ('logo', 'cover', 'gallery', 'service', 'product', 'staff', 'block', 'evidence', 'receipt', 'invoice', 'export', 'template')),
  storage_key text not null unique,
  mime text not null,
  bytes bigint not null check (bytes > 0 and bytes <= 20971520),
  width int,
  height int,
  sha256 text,
  alt_ar text,
  alt_en text,
  status text not null default 'pending' check (status in ('pending', 'ready', 'rejected', 'deleted')),
  visibility text not null default 'private' check (visibility in ('public', 'private')),
  uploaded_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id)
);

create table categories (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  kind text not null check (kind in ('service', 'product')),
  name_ar text,
  name_en text,
  slug text not null check (slug ~ '^[a-z0-9-]{1,60}$'),
  sort int not null default 0,
  is_visible boolean not null default true,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, kind, slug),
  check (coalesce(name_ar, name_en) is not null)
);

create table staff_profiles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  display_name text not null,
  display_name_en text,
  title_ar text,
  title_en text,
  bio_ar text,
  bio_en text,
  photo_asset_id uuid,
  is_active boolean not null default true,
  is_public boolean not null default true,
  -- Lower number = earlier in "any available" tie-breaks when that rule is used.
  sort int not null default 0,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, photo_asset_id) references assets(tenant_id, id)
);

alter table tenant_memberships
  add constraint memberships_staff_fk foreign key (tenant_id, staff_profile_id) references staff_profiles(tenant_id, id);
alter table invitations
  add constraint invitations_staff_fk foreign key (tenant_id, staff_profile_id) references staff_profiles(tenant_id, id);
create unique index memberships_staff_uq on tenant_memberships (tenant_id, staff_profile_id) where staff_profile_id is not null and status = 'active';

create table staff_branch_assignments (
  tenant_id uuid not null,
  staff_id uuid not null,
  branch_id uuid not null,
  primary key (tenant_id, staff_id, branch_id),
  foreign key (tenant_id, staff_id) references staff_profiles(tenant_id, id),
  foreign key (tenant_id, branch_id) references branches(tenant_id, id)
);

create table services (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  branch_id uuid,                                  -- NULL = offered at every branch
  category_id uuid,
  name_ar text,
  name_en text,
  description_ar text,
  description_en text,
  price_minor bigint not null check (price_minor >= 0),
  price_display text not null default 'fixed' check (price_display in ('fixed', 'starting_from')),
  duration_min int not null check (duration_min between 5 and 720),
  buffer_before_min int not null default 0 check (buffer_before_min between 0 and 240),
  buffer_after_min int not null default 0 check (buffer_after_min between 0 and 240),
  image_asset_id uuid,
  -- inactive: no new bookings. hidden: not shown publicly.
  is_active boolean not null default true,
  is_visible boolean not null default true,
  bookable_internally_when_hidden boolean not null default true,
  booking_mode text not null default 'individual' check (booking_mode in ('individual', 'group')),
  min_notice_min int check (min_notice_min is null or min_notice_min between 0 and 10080),
  max_advance_days int check (max_advance_days is null or max_advance_days between 1 and 365),
  requires_manual_approval boolean not null default false,
  -- Confidential: never exposed on public storefront resources.
  cost_minor bigint check (cost_minor is null or cost_minor >= 0),
  sort int not null default 0,
  archived_at timestamptz,
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  check (coalesce(name_ar, name_en) is not null),
  foreign key (tenant_id, branch_id) references branches(tenant_id, id),
  foreign key (tenant_id, category_id) references categories(tenant_id, id),
  foreign key (tenant_id, image_asset_id) references assets(tenant_id, id)
);
create index services_tenant_idx on services (tenant_id, sort) where archived_at is null;

create table service_variants (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  service_id uuid not null,
  name_ar text,
  name_en text,
  price_minor bigint not null check (price_minor >= 0),
  duration_min int not null check (duration_min between 5 and 720),
  is_active boolean not null default true,
  sort int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  check (coalesce(name_ar, name_en) is not null),
  foreign key (tenant_id, service_id) references services(tenant_id, id)
);

create table service_addons (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  service_id uuid not null,
  name_ar text,
  name_en text,
  price_minor bigint not null check (price_minor >= 0),
  duration_min int not null default 0 check (duration_min between 0 and 240),
  is_active boolean not null default true,
  sort int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  check (coalesce(name_ar, name_en) is not null),
  foreign key (tenant_id, service_id) references services(tenant_id, id)
);

-- Qualified staff per service, with optional per-specialist price/duration.
create table service_staff (
  tenant_id uuid not null,
  service_id uuid not null,
  staff_id uuid not null,
  price_override_minor bigint check (price_override_minor is null or price_override_minor >= 0),
  duration_override_min int check (duration_override_min is null or duration_override_min between 5 and 720),
  primary key (tenant_id, service_id, staff_id),
  foreign key (tenant_id, service_id) references services(tenant_id, id),
  foreign key (tenant_id, staff_id) references staff_profiles(tenant_id, id)
);
create index service_staff_staff_idx on service_staff (tenant_id, staff_id);

create table service_packages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  name_ar text,
  name_en text,
  description_ar text,
  description_en text,
  price_minor bigint not null check (price_minor >= 0),
  is_active boolean not null default true,
  is_visible boolean not null default true,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  check (coalesce(name_ar, name_en) is not null)
);

create table service_package_items (
  tenant_id uuid not null,
  package_id uuid not null,
  service_id uuid not null,
  sequence int not null default 0,
  primary key (tenant_id, package_id, service_id),
  foreign key (tenant_id, package_id) references service_packages(tenant_id, id) on delete cascade,
  foreign key (tenant_id, service_id) references services(tenant_id, id)
);

-- Proposed price changes are approved before taking effect; confirmed bookings
-- keep their snapshot regardless.
create table service_price_proposals (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  service_id uuid not null,
  current_price_minor bigint not null,
  proposed_price_minor bigint not null check (proposed_price_minor >= 0),
  reason text,
  source text not null default 'manual' check (source in ('manual', 'recommendation')),
  status text not null default 'proposed' check (status in ('proposed', 'approved', 'rejected', 'withdrawn')),
  proposed_by uuid references users(id),
  decided_by uuid references users(id),
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, service_id) references services(tenant_id, id)
);

-- ── Resources ────────────────────────────────────────────────────────────────
-- A resource is a single bookable unit (one chair, one room). A room with three
-- chairs is modelled as three resources of the same type. This keeps overlap
-- prevention exact (exclusion constraint per unit).
create table resource_types (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  name_ar text,
  name_en text,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  check (coalesce(name_ar, name_en) is not null)
);

create table resources (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  branch_id uuid not null,
  resource_type_id uuid not null,
  name text not null,
  is_active boolean not null default true,
  sort int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, branch_id) references branches(tenant_id, id),
  foreign key (tenant_id, resource_type_id) references resource_types(tenant_id, id)
);

create table service_resource_requirements (
  tenant_id uuid not null,
  service_id uuid not null,
  resource_type_id uuid not null,
  quantity int not null default 1 check (quantity between 1 and 5),
  primary key (tenant_id, service_id, resource_type_id),
  foreign key (tenant_id, service_id) references services(tenant_id, id),
  foreign key (tenant_id, resource_type_id) references resource_types(tenant_id, id)
);

-- ── Schedules ────────────────────────────────────────────────────────────────
-- Local wall-clock times in the branch timezone; converted to instants by the
-- availability engine. Several ranges per weekday are allowed.
create table working_hours (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  staff_id uuid not null,
  branch_id uuid not null,
  weekday smallint not null check (weekday between 0 and 6),
  start_time time not null,
  end_time time not null,
  effective_from date,
  effective_to date,
  created_at timestamptz not null default now(),
  check (end_time > start_time),
  check (effective_to is null or effective_from is null or effective_to >= effective_from),
  foreign key (tenant_id, staff_id) references staff_profiles(tenant_id, id),
  foreign key (tenant_id, branch_id) references branches(tenant_id, id)
);
create index working_hours_idx on working_hours (tenant_id, staff_id, weekday);

-- Recurring weekly breaks (weekday set) or one-off dated breaks.
create table staff_breaks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  staff_id uuid not null,
  weekday smallint check (weekday between 0 and 6),
  on_date date,
  start_time time not null,
  end_time time not null,
  label text,
  created_at timestamptz not null default now(),
  check (end_time > start_time),
  check ((weekday is null) <> (on_date is null)),
  foreign key (tenant_id, staff_id) references staff_profiles(tenant_id, id)
);

-- Date-specific exceptions: a day off, or replacement hours for that date.
create table shift_overrides (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  staff_id uuid not null,
  branch_id uuid not null,
  on_date date not null,
  kind text not null check (kind in ('off', 'replace', 'extra')),
  start_time time,
  end_time time,
  note text,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  check (kind = 'off' or (start_time is not null and end_time is not null and end_time > start_time)),
  foreign key (tenant_id, staff_id) references staff_profiles(tenant_id, id),
  foreign key (tenant_id, branch_id) references branches(tenant_id, id)
);
create index shift_overrides_idx on shift_overrides (tenant_id, staff_id, on_date);

-- Ad-hoc blocked time for a person or a resource (instants).
create table time_blocks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  branch_id uuid not null,
  staff_id uuid,
  resource_id uuid,
  during tstzrange not null check (not isempty(during)),
  reason text,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  check ((staff_id is null) <> (resource_id is null)),
  foreign key (tenant_id, branch_id) references branches(tenant_id, id),
  foreign key (tenant_id, staff_id) references staff_profiles(tenant_id, id),
  foreign key (tenant_id, resource_id) references resources(tenant_id, id)
);
create index time_blocks_staff_idx on time_blocks using gist (tenant_id, staff_id, during);

create table leave_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  staff_id uuid not null,
  during tstzrange not null check (not isempty(during)),
  leave_type text not null default 'annual' check (leave_type in ('annual', 'sick', 'personal', 'other')),
  status text not null default 'requested' check (status in ('requested', 'approved', 'rejected', 'cancelled')),
  reason text,
  requested_by uuid references users(id),
  decided_by uuid references users(id),
  decided_at timestamptz,
  decision_note text,
  -- Bookings that overlapped at approval time and need management action.
  affected_booking_ids uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, staff_id) references staff_profiles(tenant_id, id)
);
create index leave_requests_idx on leave_requests using gist (tenant_id, staff_id, during);

create table attendance_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  staff_id uuid not null,
  branch_id uuid,
  kind text not null check (kind in ('clock_in', 'clock_out')),
  at timestamptz not null default now(),
  source text not null default 'portal' check (source in ('portal', 'manager', 'correction')),
  note text,
  recorded_by uuid references users(id),
  corrects_event_id uuid references attendance_events(id),
  created_at timestamptz not null default now(),
  foreign key (tenant_id, staff_id) references staff_profiles(tenant_id, id)
);
create index attendance_idx on attendance_events (tenant_id, staff_id, at);

select app.apply_conventions('{{APP_ROLE}}');
select app.make_append_only('attendance_events', '{{APP_ROLE}}');

-- ════════════════════════════════════════════════════════════════════════════
-- 0002 Identity, platform roles, plans, tenants, branches, memberships.
-- ════════════════════════════════════════════════════════════════════════════

-- ── Central identity (not tenant-owned; guarded by application code) ─────────
create table users (
  id uuid primary key default gen_random_uuid(),
  email citext unique,
  phone text unique check (phone is null or phone ~ '^\+[1-9][0-9]{7,14}$'),
  email_verified_at timestamptz,
  phone_verified_at timestamptz,
  password_hash text,
  display_name text not null check (length(display_name) between 1 and 120),
  locale text not null default 'ar' check (locale in ('ar', 'en')),
  time_format text not null default '12h' check (time_format in ('12h', '24h')),
  status text not null default 'active' check (status in ('active', 'suspended', 'deleted')),
  -- Seeded demo identities are flagged so production tooling can refuse them.
  is_demo boolean not null default false,
  mfa_totp_secret_enc text,
  failed_login_count int not null default 0,
  locked_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (email is not null or phone is not null)
);

create table customer_profiles (
  user_id uuid primary key references users(id) on delete cascade,
  first_name text,
  last_name text,
  preferred_contact text check (preferred_contact in ('email', 'sms', 'whatsapp')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Platform administration roles. Never granted by public registration: only the
-- seed/CLI bootstrap or an existing platform_owner (audited) can insert here.
create table platform_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  role text not null check (role in ('platform_owner', 'support_admin', 'policy_reviewer', 'technical_admin')),
  granted_by uuid references users(id),
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid references users(id)
);
create unique index platform_roles_active_uq on platform_roles (user_id, role) where revoked_at is null;

create table sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  token_hash bytea not null unique,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  idle_expires_at timestamptz not null,
  revoked_at timestamptz,
  revoke_reason text,
  -- Step-up authentication timestamp for sensitive actions.
  reauthenticated_at timestamptz,
  ip inet,
  user_agent text
);
create index sessions_user_idx on sessions (user_id) where revoked_at is null;

-- One-time codes and tokens. Only hashes are stored.
create table verification_codes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id),
  purpose text not null check (purpose in ('verify_email', 'verify_phone', 'login', 'recovery', 'step_up', 'invite_accept')),
  channel text not null check (channel in ('email', 'sms', 'whatsapp')),
  destination text not null,
  secret_hash bytea not null,
  attempts int not null default 0,
  max_attempts int not null default 5,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
create index verification_codes_lookup_idx on verification_codes (destination, purpose) where consumed_at is null;

-- Fixed-window rate limiting shared by every app instance.
create table rate_limit_buckets (
  key text primary key,
  window_start timestamptz not null,
  count int not null
);

-- ── Plans and subscriptions ──────────────────────────────────────────────────
create table plans (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[a-z0-9_]{2,32}$'),
  name_ar text not null,
  name_en text not null,
  description_ar text,
  description_en text,
  -- Prices are not approved final values. NULL = "pricing not configured".
  price_monthly_minor bigint check (price_monthly_minor is null or price_monthly_minor >= 0),
  price_yearly_minor bigint check (price_yearly_minor is null or price_yearly_minor >= 0),
  price_is_test boolean not null default true,
  currency char(3) not null default 'SAR',
  trial_days int not null default 14 check (trial_days between 0 and 90),
  grace_days int not null default 7 check (grace_days between 0 and 60),
  status text not null default 'active' check (status in ('draft', 'active', 'retired')),
  sort int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table plan_features (
  plan_id uuid not null references plans(id) on delete cascade,
  feature_key text not null check (feature_key ~ '^[a-z0-9_.]{2,64}$'),
  enabled boolean not null default true,
  -- NULL = unlimited when enabled.
  limit_value int check (limit_value is null or limit_value >= 0),
  primary key (plan_id, feature_key)
);

-- ── Tenants ──────────────────────────────────────────────────────────────────
create table tenants (
  id uuid primary key default gen_random_uuid(),
  slug citext not null unique check (slug ~ '^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$'),
  name text not null check (length(name) between 1 and 120),
  business_type text not null check (business_type in ('salon', 'expert', 'beauty_center', 'spa')),
  status text not null default 'onboarding' check (status in ('onboarding', 'active', 'suspended', 'closed')),
  city text,
  default_locale text not null default 'ar' check (default_locale in ('ar', 'en')),
  timezone text not null default 'Asia/Riyadh',
  currency char(3) not null default 'SAR',
  -- set after first publication; FK added in builder migration
  published_version_id uuid,
  is_demo boolean not null default false,
  created_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- tenants has no tenant_id column, so RLS is applied explicitly: a tenant row is
-- visible in its own scope and in system scope. Public slug resolution goes
-- through app.resolve_tenant_slug (security definer, allowlisted columns).
alter table tenants enable row level security;
create policy tenant_self on tenants using (app.tenant_visible(id)) with check (app.tenant_visible(id));

create or replace function app.resolve_tenant_slug(p_slug text)
returns table (id uuid, slug text, name text, status text, default_locale text, timezone text, currency char(3), published_version_id uuid, business_type text)
language sql stable security definer set search_path = public as $$
  select t.id, t.slug::text, t.name, t.status, t.default_locale, t.timezone, t.currency, t.published_version_id, t.business_type
  from tenants t where t.slug = p_slug::citext
$$;

create table tenant_settings (
  tenant_id uuid primary key references tenants(id),
  -- Booking policy (snapshotted into each booking)
  slot_increment_min int not null default 15 check (slot_increment_min in (5, 10, 15, 20, 30, 60)),
  min_notice_min int not null default 60 check (min_notice_min between 0 and 10080),
  max_advance_days int not null default 60 check (max_advance_days between 1 and 365),
  hold_ttl_sec int not null default 600 check (hold_ttl_sec between 60 and 3600),
  no_show_grace_min int not null default 15 check (no_show_grace_min between 0 and 240),
  max_gap_between_items_min int not null default 30 check (max_gap_between_items_min between 0 and 240),
  any_staff_rule text not null default 'earliest_then_least_booked'
    check (any_staff_rule in ('earliest_then_least_booked', 'earliest_then_staff_order')),
  free_cancellation_hours int not null default 24 check (free_cancellation_hours between 0 and 720),
  late_cancellation_fee_bp int not null default 0 check (late_cancellation_fee_bp between 0 and 10000),
  deposit_mode text not null default 'none' check (deposit_mode in ('none', 'percent', 'fixed')),
  deposit_percent_bp int not null default 0 check (deposit_percent_bp between 0 and 10000),
  deposit_fixed_minor bigint not null default 0 check (deposit_fixed_minor >= 0),
  allow_pay_on_site boolean not null default true,
  allow_full_prepay boolean not null default true,
  booking_requires_account boolean not null default true,
  -- Tax rules are configurable and documented, not hardcoded assumptions.
  tax_rate_bp int not null default 0 check (tax_rate_bp between 0 and 10000),
  prices_include_tax boolean not null default true,
  tax_label text,
  -- Legal identity (settings; no e-invoicing compliance is claimed)
  legal_name text,
  tax_number text,
  legal_address text,
  -- Contact & presence
  contact_phone text,
  contact_email citext,
  contact_whatsapp text,
  social_links jsonb not null default '{}'::jsonb,
  -- Plan policy may require the "Powered by LUMA" mark.
  powered_by_visible boolean not null default true,
  time_format text not null default '12h' check (time_format in ('12h', '24h')),
  -- Notification channels the business enabled (still subject to provider availability)
  notify_channels text[] not null default array['in_app']::text[],
  version int not null default 1,
  updated_at timestamptz not null default now()
);

create table branches (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  name text not null,
  city text,
  address text,
  latitude numeric(9, 6),
  longitude numeric(9, 6),
  timezone text not null default 'Asia/Riyadh',
  phone text,
  is_primary boolean not null default false,
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id)
);
create unique index branches_one_primary on branches (tenant_id) where is_primary and status = 'active';

-- Opening hours per weekday; multiple ranges per day allowed (e.g. split shifts).
create table branch_hours (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  branch_id uuid not null,
  weekday smallint not null check (weekday between 0 and 6), -- 0 = Sunday
  opens time not null,
  closes time not null,
  check (closes > opens),
  foreign key (tenant_id, branch_id) references branches(tenant_id, id) on delete cascade
);
create index branch_hours_idx on branch_hours (tenant_id, branch_id, weekday);

create table tenant_counters (
  tenant_id uuid not null references tenants(id),
  kind text not null,
  value bigint not null default 0,
  primary key (tenant_id, kind)
);

-- ── Memberships and invitations ──────────────────────────────────────────────
create table tenant_memberships (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  user_id uuid not null references users(id),
  role text not null check (role in ('owner', 'manager', 'receptionist', 'specialist', 'finance')),
  -- Delegated capabilities on top of the role defaults, and explicit removals.
  granted_capabilities text[] not null default '{}',
  revoked_capabilities text[] not null default '{}',
  status text not null default 'active' check (status in ('active', 'suspended', 'removed')),
  staff_profile_id uuid,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, user_id),
  unique (tenant_id, id)
);
-- Exactly one active owner per business; ownership transfer is an explicit flow.
create unique index memberships_one_owner on tenant_memberships (tenant_id) where role = 'owner' and status = 'active';
create index memberships_user_idx on tenant_memberships (user_id) where status = 'active';

-- Membership lookup for the session user across tenants (the business selector).
-- security definer so it can run before a tenant scope exists; returns only the
-- caller's own memberships.
create or replace function app.memberships_for_user(p_user uuid)
returns table (membership_id uuid, tenant_id uuid, tenant_slug text, tenant_name text, tenant_status text, role text,
               granted_capabilities text[], revoked_capabilities text[], staff_profile_id uuid, business_type text)
language sql stable security definer set search_path = public as $$
  select m.id, t.id, t.slug::text, t.name, t.status, m.role, m.granted_capabilities, m.revoked_capabilities, m.staff_profile_id, t.business_type
  from tenant_memberships m join tenants t on t.id = m.tenant_id
  where m.user_id = p_user and m.status = 'active' and t.status <> 'closed'
  order by t.name
$$;

create table invitations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  email citext,
  phone text,
  role text not null check (role in ('manager', 'receptionist', 'specialist', 'finance')),
  granted_capabilities text[] not null default '{}',
  staff_profile_id uuid,
  token_hash bytea not null unique,
  invited_by uuid not null references users(id),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  accepted_by uuid references users(id),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  check (email is not null or phone is not null)
);

-- Invitation lookup by token before a tenant scope exists.
create or replace function app.invitation_by_token(p_hash bytea)
returns setof invitations
language sql stable security definer set search_path = public as $$
  select * from invitations where token_hash = p_hash
$$;

-- ── Subscriptions (LUMA revenue; independent of customer payments) ───────────
create table subscriptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  plan_id uuid not null references plans(id),
  status text not null check (status in ('trialing', 'active', 'past_due', 'paused', 'cancelled', 'expired')),
  billing_cycle text not null default 'monthly' check (billing_cycle in ('monthly', 'yearly')),
  trial_ends_at timestamptz,
  current_period_start timestamptz,
  current_period_end timestamptz,
  grace_until timestamptz,
  cancel_at timestamptz,
  cancelled_at timestamptz,
  provider text not null default 'none',
  provider_ref text,
  -- Set when a downgrade leaves the tenant above new limits; data is never deleted.
  overage_state jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index subscriptions_one_current on subscriptions (tenant_id) where status in ('trialing', 'active', 'past_due', 'paused');

create table subscription_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  subscription_id uuid not null references subscriptions(id),
  kind text not null,
  from_status text,
  to_status text,
  data jsonb not null default '{}'::jsonb,
  actor_user_id uuid references users(id),
  created_at timestamptz not null default now()
);

create table usage_counters (
  tenant_id uuid not null references tenants(id),
  metric text not null,
  period_start date not null,
  value bigint not null default 0,
  primary key (tenant_id, metric, period_start)
);

create table platform_invoices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  subscription_id uuid references subscriptions(id),
  number text not null unique,
  amount_minor bigint not null check (amount_minor >= 0),
  currency char(3) not null default 'SAR',
  status text not null check (status in ('draft', 'open', 'paid', 'void', 'uncollectible')),
  period_start date,
  period_end date,
  issued_at timestamptz,
  paid_at timestamptz,
  provider_ref text,
  is_test boolean not null default true,
  created_at timestamptz not null default now()
);

-- Time-limited, reasoned support access. No silent impersonation: the support
-- user acts as themselves and every action is audited with the grant id.
create table support_access_grants (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  platform_user_id uuid not null references users(id),
  reason text not null check (length(reason) >= 10),
  access_level text not null default 'read' check (access_level in ('read', 'write')),
  starts_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  check (expires_at > starts_at and expires_at <= starts_at + interval '24 hours')
);

-- ── Infrastructure shared by every domain ────────────────────────────────────
create table audit_logs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references tenants(id),
  actor_user_id uuid references users(id),
  actor_kind text not null check (actor_kind in ('user', 'platform', 'support', 'system', 'customer', 'anonymous')),
  support_grant_id uuid references support_access_grants(id),
  action text not null,
  target_type text,
  target_id text,
  request_id text,
  ip inet,
  -- Redacted metadata only; never secrets or full private content.
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index audit_logs_tenant_idx on audit_logs (tenant_id, created_at desc);
create index audit_logs_action_idx on audit_logs (action, created_at desc);

create table idempotency_records (
  id uuid primary key default gen_random_uuid(),
  scope text not null,          -- e.g. "user:<uuid>" or "tenant:<uuid>"
  key text not null check (length(key) between 8 and 200),
  operation text not null,
  request_hash text not null,
  status text not null check (status in ('in_progress', 'completed')),
  response_status int,
  response_body jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '24 hours',
  unique (scope, operation, key)
);

create table outbox_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references tenants(id),
  topic text not null,
  payload jsonb not null,
  dedupe_key text unique,
  available_at timestamptz not null default now(),
  attempts int not null default 0,
  last_error text,
  processed_at timestamptz,
  created_at timestamptz not null default now()
);
create index outbox_pending_idx on outbox_events (available_at) where processed_at is null;

create table job_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references tenants(id),
  kind text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  dedupe_key text unique,
  run_at timestamptz not null default now(),
  attempts int not null default 0,
  max_attempts int not null default 5,
  locked_by text,
  locked_at timestamptz,
  last_error text,
  result jsonb,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index job_runs_ready_idx on job_runs (run_at) where status = 'queued';

create table notifications (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references tenants(id),
  user_id uuid not null references users(id),
  kind text not null,
  title_ar text not null,
  title_en text not null,
  body_ar text,
  body_en text,
  -- Internal relative path only (validated in application code).
  target_path text check (target_path is null or target_path ~ '^/[A-Za-z0-9/_\-?=&.%]*$'),
  data jsonb not null default '{}'::jsonb,
  dedupe_key text,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '180 days'
);
create index notifications_user_idx on notifications (user_id, created_at desc);
create unique index notifications_dedupe on notifications (user_id, dedupe_key) where dedupe_key is not null;

-- A user's own notifications across tenants (the bell is global per person).
create or replace function app.notifications_for_user(p_user uuid, p_before timestamptz, p_limit int)
returns setof notifications
language sql stable security definer set search_path = public as $$
  select * from notifications
  where user_id = p_user and expires_at > now() and (p_before is null or created_at < p_before)
  order by created_at desc limit least(p_limit, 100)
$$;

create table notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references tenants(id),
  notification_id uuid references notifications(id),
  channel text not null check (channel in ('email', 'sms', 'whatsapp', 'push')),
  destination_masked text not null,
  template_key text not null,
  locale text not null default 'ar',
  status text not null check (status in ('pending', 'simulated', 'sent', 'delivered', 'failed', 'suppressed')),
  provider text not null default 'none',
  provider_ref text,
  attempts int not null default 0,
  error text,
  dedupe_key text unique,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Development-only outbox for one-time codes when DEV_OTP_ECHO is on.
-- Production code paths never write here.
create table dev_message_outbox (
  id uuid primary key default gen_random_uuid(),
  destination text not null,
  channel text not null,
  subject text,
  body text not null,
  created_at timestamptz not null default now()
);

select app.apply_conventions('{{APP_ROLE}}');
select app.make_append_only('audit_logs', '{{APP_ROLE}}');
select app.make_append_only('subscription_events', '{{APP_ROLE}}');
grant execute on function app.resolve_tenant_slug(text) to {{APP_ROLE}};
grant execute on function app.memberships_for_user(uuid) to {{APP_ROLE}};
grant execute on function app.invitation_by_token(bytea) to {{APP_ROLE}};
grant execute on function app.notifications_for_user(uuid, timestamptz, int) to {{APP_ROLE}};

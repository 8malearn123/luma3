-- ════════════════════════════════════════════════════════════════════════════
-- 0008 Customer incidents, reviews of incidents, configurable policy rules,
--      policy decisions (tenant- or platform-scoped), appeals.
--
-- Principles enforced here and in the policy service:
--   * No public "blacklist"; a business never sees another business's incidents.
--   * One free-text report never changes platform-wide eligibility by itself:
--     platform decisions require a reviewer with the policy_reviewer role.
--   * Decisions expire / come up for review, can be appealed, and supersede each
--     other explicitly. AI is never the decision maker.
-- ════════════════════════════════════════════════════════════════════════════

create table customer_incidents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  booking_id uuid,
  tenant_customer_id uuid not null,
  customer_user_id uuid references users(id),
  type text not null check (type in ('no_show', 'late_cancellation', 'payment_dispute', 'conduct', 'other')),
  description text not null check (length(description) between 5 and 2000),
  occurred_at timestamptz not null,
  submitted_by uuid not null references users(id),
  status text not null default 'submitted' check (status in ('submitted', 'under_review', 'confirmed', 'rejected', 'corrected')),
  -- Only the tenant may escalate a confirmed incident for platform review.
  escalated_to_platform_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  check (type not in ('no_show', 'late_cancellation') or booking_id is not null),
  foreign key (tenant_id, booking_id) references bookings(tenant_id, id),
  foreign key (tenant_id, tenant_customer_id) references tenant_customers(tenant_id, id)
);
-- The same booking cannot be reported twice for the same incident type.
create unique index customer_incidents_once on customer_incidents (tenant_id, booking_id, type)
  where booking_id is not null and status <> 'rejected';

create table incident_evidence (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  incident_id uuid not null,
  asset_id uuid,
  note text,
  added_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  -- Evidence retention is explicit; purge job removes expired evidence assets.
  retain_until timestamptz not null default now() + interval '2 years',
  foreign key (tenant_id, incident_id) references customer_incidents(tenant_id, id),
  foreign key (tenant_id, asset_id) references assets(tenant_id, id)
);

create table incident_reviews (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  incident_id uuid not null,
  reviewer_id uuid not null references users(id),
  reviewer_scope text not null check (reviewer_scope in ('tenant', 'platform')),
  from_status text not null,
  to_status text not null,
  note text not null,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, incident_id) references customer_incidents(tenant_id, id)
);

-- Configurable criteria. Thresholds are NOT approved final values; seeded rules
-- are flagged experimental.
create table policy_rules (
  id uuid primary key default gen_random_uuid(),
  scope text not null check (scope in ('tenant', 'platform')),
  tenant_id uuid references tenants(id),
  key text not null,
  -- e.g. {"incident_type":"no_show","min_confirmed":2,"window_days":180}
  criteria jsonb not null,
  suggested_action text not null check (suggested_action in ('require_deposit', 'require_full_payment', 'manual_approval')),
  is_enabled boolean not null default true,
  is_experimental boolean not null default true,
  version int not null default 1,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((scope = 'tenant') = (tenant_id is not null))
);

create table policy_decisions (
  id uuid primary key default gen_random_uuid(),
  scope text not null check (scope in ('tenant', 'platform')),
  tenant_id uuid references tenants(id),
  customer_user_id uuid references users(id),
  tenant_customer_id uuid,
  action text not null check (action in ('default', 'require_deposit', 'require_full_payment', 'manual_approval', 'suspend_account')),
  -- Priority used when several decisions apply (higher wins); see policy service.
  reason text not null check (length(reason) >= 5),
  -- Customer-facing explanation (no other customers' or employees' data).
  customer_explanation_ar text,
  customer_explanation_en text,
  evidence_refs jsonb not null default '[]'::jsonb,
  rule_id uuid references policy_rules(id),
  reviewer_id uuid not null references users(id),
  status text not null default 'active' check (status in ('active', 'superseded', 'revoked', 'expired')),
  effective_at timestamptz not null default now(),
  expires_at timestamptz,
  review_at timestamptz,
  supersedes_id uuid references policy_decisions(id),
  is_experimental boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((scope = 'tenant') = (tenant_id is not null)),
  check (scope = 'tenant' or customer_user_id is not null),
  check (scope = 'platform' or tenant_customer_id is not null or customer_user_id is not null),
  check (expires_at is null or expires_at > effective_at),
  -- Account suspension is exceptional and platform-only.
  check (action <> 'suspend_account' or scope = 'platform'),
  foreign key (tenant_id, tenant_customer_id) references tenant_customers(tenant_id, id)
);
create index policy_decisions_customer_idx on policy_decisions (customer_user_id, status);
create index policy_decisions_tenant_customer_idx on policy_decisions (tenant_id, tenant_customer_id, status);

-- Returns the *actions* (not reasons or evidence) of active platform-scoped
-- decisions for a customer, so a tenant checkout can honour them without being
-- able to read the platform's reasoning or other salons' reports.
create or replace function app.platform_decisions_for_customer(p_user uuid)
returns table (id uuid, action text, effective_at timestamptz, expires_at timestamptz, customer_explanation_ar text, customer_explanation_en text)
language sql stable security definer set search_path = public as $$
  select d.id, d.action, d.effective_at, d.expires_at, d.customer_explanation_ar, d.customer_explanation_en
  from policy_decisions d
  where d.scope = 'platform' and d.customer_user_id = p_user and d.status = 'active'
    and d.effective_at <= now() and (d.expires_at is null or d.expires_at > now())
$$;

create table appeals (
  id uuid primary key default gen_random_uuid(),
  customer_user_id uuid not null references users(id),
  decision_id uuid references policy_decisions(id),
  incident_id uuid references customer_incidents(id),
  -- Tenant that owns the appealed item (NULL for platform-scope decisions).
  tenant_id uuid references tenants(id),
  message text not null check (length(message) between 10 and 2000),
  status text not null default 'submitted' check (status in ('submitted', 'under_review', 'accepted', 'rejected', 'withdrawn')),
  resolution_note text,
  reviewer_id uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz,
  check (decision_id is not null or incident_id is not null)
);
create unique index appeals_one_open on appeals (customer_user_id, coalesce(decision_id, incident_id)) where status in ('submitted', 'under_review');

select app.apply_conventions('{{APP_ROLE}}');
select app.make_append_only('incident_reviews', '{{APP_ROLE}}');
grant execute on function app.platform_decisions_for_customer(uuid) to {{APP_ROLE}};

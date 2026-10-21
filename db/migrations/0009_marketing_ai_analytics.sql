-- ════════════════════════════════════════════════════════════════════════════
-- 0009 Storefront analytics, metric snapshots, Loom Marketing (preferences,
--      plans + immutable versions, recommendations), segments, campaigns,
--      suppression, trend radar, AI jobs/runs/prompt versions.
-- ════════════════════════════════════════════════════════════════════════════

create table analytics_events (
  id uuid primary key,                      -- client-generated event_id (dedupe)
  tenant_id uuid not null references tenants(id),
  session_id text not null check (length(session_id) between 8 and 64),  -- pseudonymous, rotating
  type text not null check (type in ('page_view', 'service_view', 'product_view', 'booking_start', 'checkout_start',
                                     'booking_confirmed', 'order_paid', 'availability_empty', 'waitlist_join')),
  entity_id uuid,
  path text,
  occurred_at timestamptz not null,
  received_at timestamptz not null default now(),
  referrer_host text,
  utm jsonb,
  device text check (device in ('mobile', 'tablet', 'desktop', 'unknown')),
  is_excluded boolean not null default false,
  exclusion_reason text check (exclusion_reason in ('preview', 'builder', 'member', 'bot', 'test'))
);
create index analytics_events_tenant_idx on analytics_events (tenant_id, occurred_at);
create index analytics_events_type_idx on analytics_events (tenant_id, type, occurred_at);

create table daily_metrics (
  tenant_id uuid not null references tenants(id),
  day date not null,
  metric text not null,
  dimension text not null default '',
  value numeric not null,
  computed_at timestamptz not null default now(),
  primary key (tenant_id, day, metric, dimension)
);

-- Trusted, programmatic metric snapshot fed to the AI (with period & freshness).
create table metric_snapshots (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  kind text not null,
  period_start date not null,
  period_end date not null,
  data jsonb not null,
  data_as_of timestamptz not null,
  content_hash text not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, id)
);

create table marketing_preferences (
  tenant_id uuid primary key references tenants(id),
  goals jsonb not null default '[]'::jsonb,
  monthly_budget_minor bigint check (monthly_budget_minor is null or monthly_budget_minor >= 0),
  max_discount_bp int not null default 2000 check (max_discount_bp between 0 and 10000),
  tone text,
  channels text[] not null default '{}',
  audience_notes text,
  photography_resources text,
  schedule_enabled boolean not null default false,
  updated_by uuid references users(id),
  updated_at timestamptz not null default now()
);

create table marketing_plans (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  kind text not null check (kind in ('monthly', 'weekly')),
  parent_plan_id uuid,
  period_start date not null,
  period_end date not null,
  title text not null,
  status text not null default 'draft' check (status in ('draft', 'proposed', 'under_review', 'approved', 'in_progress', 'completed', 'deferred', 'rejected')),
  current_version_id uuid,
  approved_version_id uuid,
  approved_by uuid references users(id),
  approved_at timestamptz,
  is_example boolean not null default false,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  check (kind = 'monthly' or parent_plan_id is not null or is_example),
  foreign key (tenant_id, parent_plan_id) references marketing_plans(tenant_id, id)
);

create table plan_versions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  plan_id uuid not null,
  version int not null,
  -- {goal, baseline, initiatives[], activities[], dates, owner, budget, metrics[]}
  content jsonb not null,
  source text not null check (source in ('ai', 'rules', 'manual', 'example')),
  ai_run_id uuid,
  metric_snapshot_id uuid,
  validation jsonb not null default '{}'::jsonb,
  change_note text,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (plan_id, version),
  foreign key (tenant_id, plan_id) references marketing_plans(tenant_id, id)
);
alter table marketing_plans add constraint marketing_plans_current_fk foreign key (tenant_id, current_version_id) references plan_versions(tenant_id, id);
alter table marketing_plans add constraint marketing_plans_approved_fk foreign key (tenant_id, approved_version_id) references plan_versions(tenant_id, id);

create table plan_comments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  plan_id uuid not null,
  plan_version_id uuid,
  author_id uuid not null references users(id),
  body text not null check (length(body) between 1 and 2000),
  created_at timestamptz not null default now(),
  foreign key (tenant_id, plan_id) references marketing_plans(tenant_id, id)
);

create table campaign_segments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  name text not null,
  -- Explainable, allowlisted conditions compiled to parameterised SQL.
  definition jsonb not null,
  description text,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id)
);

create table recommendations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  title text not null,
  category text not null check (category in ('quiet_periods', 'reactivation', 'seasonal', 'service_promotion', 'packages', 'cross_sell',
                                             'loyalty', 'content', 'pricing', 'booking_experience', 'campaign_review', 'trend')),
  horizon text not null check (horizon in ('weekly', 'monthly', 'ongoing')),
  period_start date,
  period_end date,
  evidence_refs jsonb not null default '[]'::jsonb,
  measured_metrics jsonb not null default '{}'::jsonb,
  opportunity text not null,
  suggested_action text not null,
  target_segment_id uuid,
  timing text,
  estimated_cost jsonb not null default '{"status":"unknown"}'::jsonb,
  capacity_check jsonb not null default '{"status":"unknown"}'::jsonb,
  margin_check jsonb not null default '{"status":"unknown"}'::jsonb,
  draft_content jsonb,
  channel text,
  prerequisites jsonb not null default '[]'::jsonb,
  success_metric text,
  experiment_design text,
  confidence text not null default 'low' check (confidence in ('low', 'medium', 'high')),
  limitations text,
  proposed_target text,
  forecast text,
  validation jsonb not null default '{}'::jsonb,
  status text not null default 'open' check (status in ('open', 'accepted', 'dismissed', 'deferred', 'expired', 'superseded')),
  decided_by uuid references users(id),
  decided_at timestamptz,
  data_as_of timestamptz not null,
  review_at timestamptz,
  expires_at timestamptz,
  source_type text not null check (source_type in ('ai', 'rules', 'example')),
  provider text,
  model text,
  prompt_version text,
  ai_run_id uuid,
  metric_snapshot_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, target_segment_id) references campaign_segments(tenant_id, id)
);

create table campaigns (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  name text not null,
  segment_id uuid,
  channel text not null check (channel in ('email', 'sms', 'whatsapp', 'in_app')),
  status text not null default 'draft' check (status in ('draft', 'approved', 'scheduled', 'sending', 'sent', 'paused', 'failed', 'completed', 'cancelled')),
  content jsonb not null,
  scheduled_at timestamptz,
  approved_by uuid references users(id),
  approved_at timestamptz,
  coupon_id uuid,
  utm jsonb not null default '{}'::jsonb,
  holdout_bp int not null default 0 check (holdout_bp between 0 and 5000),
  attribution_window_days int not null default 14 check (attribution_window_days between 1 and 90),
  frequency_cap_days int not null default 7 check (frequency_cap_days between 0 and 90),
  quiet_hours jsonb not null default '{"from":"21:00","to":"09:00"}'::jsonb,
  recommendation_id uuid,
  plan_id uuid,
  stats jsonb not null default '{}'::jsonb,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, segment_id) references campaign_segments(tenant_id, id),
  foreign key (tenant_id, coupon_id) references coupons(tenant_id, id),
  foreign key (tenant_id, recommendation_id) references recommendations(tenant_id, id),
  foreign key (tenant_id, plan_id) references marketing_plans(tenant_id, id)
);

create table campaign_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  campaign_id uuid not null,
  tenant_customer_id uuid,
  kind text not null check (kind in ('targeted', 'holdout', 'suppressed', 'queued', 'simulated', 'sent', 'delivered', 'failed', 'clicked', 'converted', 'unsubscribed')),
  ref_type text,
  ref_id uuid,
  value_minor bigint,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, campaign_id) references campaigns(tenant_id, id),
  foreign key (tenant_id, tenant_customer_id) references tenant_customers(tenant_id, id)
);
create unique index campaign_events_conversion_once on campaign_events (campaign_id, ref_type, ref_id) where kind = 'converted';
create index campaign_events_idx on campaign_events (tenant_id, campaign_id, kind);

create table suppression_list (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  channel text not null check (channel in ('email', 'sms', 'whatsapp')),
  destination_hash bytea not null,
  reason text not null check (reason in ('unsubscribed', 'bounced', 'complaint', 'manual')),
  created_at timestamptz not null default now(),
  unique (tenant_id, channel, destination_hash)
);

-- ── Trend radar ──────────────────────────────────────────────────────────────
create table trend_sources (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references tenants(id),     -- NULL = platform-managed source
  kind text not null check (kind in ('rss', 'api', 'user_link')),
  name text not null,
  url text not null,
  access_basis text not null,                -- why we may read it (licence/ToS/user-provided)
  status text not null default 'active' check (status in ('active', 'disabled', 'error')),
  last_fetched_at timestamptz,
  last_error text,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table trend_observations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references tenants(id),
  source_id uuid references trend_sources(id),
  url text not null,
  title text not null,
  summary text,
  published_at timestamptz,
  observed_at timestamptz not null default now(),
  region text,
  topic text,
  cluster_key text,
  metrics jsonb not null default '{}'::jsonb,       -- only metrics the source actually provides
  evidence_strength text not null check (evidence_strength in ('anecdotal', 'early_signal', 'quantified')),
  content_hash text not null,
  created_at timestamptz not null default now(),
  unique (source_id, content_hash)
);

create table trend_assessments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  cluster_key text not null,
  observation_ids uuid[] not null,
  what_is_happening text not null,
  evidence_strength text not null check (evidence_strength in ('anecdotal', 'early_signal', 'quantified')),
  fit text not null check (fit in ('good', 'partial', 'poor')),
  fit_explanation text not null,
  application_idea text,
  est_time text,
  est_cost text,
  valid_until date,
  status text not null default 'open' check (status in ('open', 'added_to_plan', 'dismissed', 'expired')),
  source_type text not null check (source_type in ('ai', 'rules', 'example')),
  ai_run_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ── AI jobs & provenance ─────────────────────────────────────────────────────
create table prompt_versions (
  key text not null,
  version text not null,
  description text,
  output_schema jsonb not null,
  created_at timestamptz not null default now(),
  primary key (key, version)
);

create table ai_jobs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  kind text not null check (kind in ('monthly_plan', 'weekly_plan', 'recommendations', 'trend_assessment', 'customization', 'employee_insights')),
  period_key text not null,
  status text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'insufficient_data', 'unavailable')),
  attempts int not null default 0,
  error_code text,
  error_message text,
  requested_by uuid references users(id),
  trigger text not null default 'manual' check (trigger in ('manual', 'schedule')),
  result_ref jsonb,
  regeneration_of uuid references ai_jobs(id),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (tenant_id, id)
);
-- Idempotent per tenant/type/period: only one live job at a time.
create unique index ai_jobs_live_uq on ai_jobs (tenant_id, kind, period_key) where status in ('queued', 'running');

create table ai_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  job_id uuid,
  provider text not null,
  model text not null,
  prompt_key text not null,
  prompt_version text not null,
  input_digest text not null,
  -- Redacted: aggregated metrics only; no names/phones; no secrets.
  input_summary jsonb not null default '{}'::jsonb,
  output jsonb,
  status text not null check (status in ('succeeded', 'failed', 'invalid_output', 'timeout', 'rate_limited', 'quota_exceeded', 'unavailable')),
  error text,
  latency_ms int,
  input_tokens int,
  output_tokens int,
  cost_usd_micros bigint,           -- NULL when no documented price is configured
  cache_key text,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, job_id) references ai_jobs(tenant_id, id)
);
create index ai_runs_tenant_idx on ai_runs (tenant_id, created_at desc);
create index ai_runs_cache_idx on ai_runs (tenant_id, cache_key) where status = 'succeeded';

select app.apply_conventions('{{APP_ROLE}}');
select app.make_append_only('plan_versions', '{{APP_ROLE}}');
select app.make_append_only('campaign_events', '{{APP_ROLE}}');
select app.make_append_only('ai_runs', '{{APP_ROLE}}');

-- ════════════════════════════════════════════════════════════════════════════
-- 0400 Analytics / employee performance / Loom Marketing extensions.
--
--   * performance_settings: per-tenant composite weights and minimum samples
--     for employee indicators (no evaluation below the minimums).
--   * marketing_calendar_events: dates the owner verified (holidays, seasons,
--     local events). Loom never invents dates; with no rows it says so.
--   * scheduling columns on marketing_preferences (business timezone).
--   * recommendation fingerprint (kept until decided or materially changed).
--   * campaign tracking code and lifecycle timestamps.
--   * ai_jobs retry bound and target plan for regeneration.
-- ════════════════════════════════════════════════════════════════════════════

create table performance_settings (
  tenant_id uuid primary key references tenants(id),
  -- Relative weights (0-100) of the separate indicators in the composite.
  weights jsonb not null default '{"satisfaction":30,"repeat":20,"punctuality":20,"complaints":15,"occupancy":15}'::jsonb,
  min_completed int not null default 20 check (min_completed between 5 and 1000),
  min_reviews int not null default 8 check (min_reviews between 3 and 1000),
  min_timed int not null default 10 check (min_timed between 3 and 1000),
  punctuality_grace_min int not null default 10 check (punctuality_grace_min between 0 and 60),
  updated_by uuid references users(id),
  updated_at timestamptz not null default now()
);

create table marketing_calendar_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  title text not null check (length(title) between 1 and 120),
  kind text not null check (kind in ('holiday', 'season', 'local_event', 'business_event')),
  starts_on date not null,
  ends_on date not null,
  relevance_note text check (relevance_note is null or length(relevance_note) <= 500),
  source_url text check (source_url is null or source_url ~ '^https://'),
  verified_by uuid not null references users(id),
  verified_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  check (ends_on >= starts_on)
);
create index marketing_calendar_idx on marketing_calendar_events (tenant_id, starts_on);

alter table marketing_preferences
  add column weekly_weekday smallint not null default 0 check (weekly_weekday between 0 and 6),
  add column monthly_day smallint not null default 1 check (monthly_day between 1 and 28),
  add column local_hour smallint not null default 7 check (local_hour between 0 and 23),
  add column weekly_enabled boolean not null default true,
  add column monthly_enabled boolean not null default true,
  add column brand_style text,
  add column promote_products boolean not null default true;

alter table recommendations
  add column fingerprint text,
  add column plan_id uuid,
  add constraint recommendations_plan_fk foreign key (tenant_id, plan_id) references marketing_plans(tenant_id, id);
create index recommendations_live_idx on recommendations (tenant_id, fingerprint) where status in ('open', 'deferred');

alter table campaigns
  add column tracking_code text check (tracking_code is null or tracking_code ~ '^[A-Z0-9-]{4,32}$'),
  add column started_at timestamptz,
  add column finished_at timestamptz,
  add column cancelled_at timestamptz,
  add column last_error text;
create unique index campaigns_tracking_uq on campaigns (tenant_id, tracking_code) where tracking_code is not null;

alter table ai_jobs
  add column max_attempts int not null default 3 check (max_attempts between 1 and 10),
  add column target_plan_id uuid,
  add constraint ai_jobs_plan_fk foreign key (tenant_id, target_plan_id) references marketing_plans(tenant_id, id);

create index analytics_events_session_idx on analytics_events (tenant_id, session_id);
create unique index trend_sources_tenant_url_uq on trend_sources (tenant_id, url) where tenant_id is not null;
create index trend_observations_tenant_idx on trend_observations (tenant_id, observed_at desc);
create index campaign_events_customer_idx on campaign_events (tenant_id, tenant_customer_id, kind, created_at);

select app.apply_conventions('{{APP_ROLE}}');
-- apply_conventions re-grants table privileges; restore append-only ledgers touched above.
select app.make_append_only('plan_versions', '{{APP_ROLE}}');
select app.make_append_only('campaign_events', '{{APP_ROLE}}');
select app.make_append_only('ai_runs', '{{APP_ROLE}}');

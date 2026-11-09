-- ════════════════════════════════════════════════════════════════════════════
-- 0730 Loom Marketing phase 5: memory, measurement and the change aggregator.
-- See docs/LOOM_CORE.md (§10–§12) and docs/LOOM_MARKETING_ARCHITECTURE.md §10, §13.
--
--   loom.decision_history       §10.1 decision ladder: one append-only row per
--                               stage (viewed, reacted, decided, scheduled,
--                               executed, completed, measured) per opportunity
--                               and/or initiative.
--   loom.feedback               like / dislike (taste). Stored apart from the
--                               ladder and NEVER read as an outcome.
--   loom.initiatives            §10.2 initiative record: opportunity → converted
--                               artifact (plan action / campaign / price proposal)
--                               with a FROZEN baseline and original proposal.
--   loom.initiative_executions  what was actually executed (connector or manual).
--   loom.outcomes               §10.3 measured results (append-only, one per
--                               initiative window).
--   loom.change_signals         §13 change aggregator: (business, type, scope)
--                               with threshold + cool-down.
--   loom_export.campaign_groups target / holdout groups per campaign with their
--                               conversions inside the attribution window (the
--                               holdout conversions the core view did not expose).
--
-- app.apply_conventions() covers schema public only: RLS, grants and the
-- append-only guards for the new loom tables are set explicitly below.
-- ════════════════════════════════════════════════════════════════════════════

-- ── Decision ladder ─────────────────────────────────────────────────────────
create table loom.decision_history (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  opportunity_id uuid,
  initiative_id uuid,
  stage text not null check (stage in ('viewed', 'reacted', 'decided', 'scheduled', 'executed', 'completed', 'measured')),
  action text check (action is null or action ~ '^[a-z][a-z0-9_]{1,39}$'),
  reason text check (reason in ('capacity_staffing', 'capacity_inventory', 'budget', 'brand_fit', 'timing',
    'already_doing', 'disagree_with_data', 'not_valuable', 'other')),
  note text check (note is null or length(note) <= 1000),
  counts_as_idea_failure boolean,
  data jsonb not null default '{}'::jsonb check (jsonb_typeof(data) = 'object'),
  actor_id uuid references users(id),
  created_at timestamptz not null default now(),
  check (opportunity_id is not null or initiative_id is not null),
  foreign key (business_id, opportunity_id) references loom.opportunities (business_id, id)
);
create index decision_history_opp_idx on loom.decision_history (business_id, opportunity_id, created_at);
create index decision_history_init_idx on loom.decision_history (business_id, initiative_id, created_at);

create table loom.feedback (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  opportunity_id uuid not null,
  reaction text not null check (reaction in ('like', 'dislike', 'none')),
  actor_id uuid references users(id),
  created_at timestamptz not null default now(),
  foreign key (business_id, opportunity_id) references loom.opportunities (business_id, id)
);
create index feedback_opp_idx on loom.feedback (business_id, opportunity_id, actor_id, created_at desc);

-- ── Initiatives ─────────────────────────────────────────────────────────────
create table loom.initiatives (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  opportunity_id uuid not null,
  artifact_kind text not null check (artifact_kind in ('plan_action', 'campaign_draft', 'price_proposal')),
  artifact_ref text not null check (length(artifact_ref) between 1 and 120),
  status text not null default 'scheduled' check (status in ('scheduled', 'executing', 'completed', 'measured', 'closed', 'cancelled')),
  category text not null,
  offering_ids uuid[] not null default '{}',
  goal_metrics text[] not null default '{}',
  window_from date not null,
  window_to date not null,
  -- Frozen at creation (trigger below): metrics known when the proposal was converted.
  baseline jsonb not null,
  baseline_data_version text,
  baseline_analysis_id uuid,
  original_proposal jsonb not null,
  user_edits jsonb not null default '[]'::jsonb,
  approved_version jsonb not null,
  execution jsonb,
  results jsonb,
  external_factors jsonb not null default '[]'::jsonb,
  measurement_design text not null check (measurement_design in ('holdout', 'ab', 'pre_post_with_control', 'observational')),
  measurement_quality text check (measurement_quality in ('experimental', 'quasi', 'observational', 'insufficient')),
  learnings jsonb not null default '[]'::jsonb,
  completed_at timestamptz,
  measured_at timestamptz,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (window_to >= window_from),
  unique (business_id, opportunity_id, artifact_kind, artifact_ref),
  unique (business_id, id),
  foreign key (business_id, opportunity_id) references loom.opportunities (business_id, id)
);
create index initiatives_business_idx on loom.initiatives (business_id, status, window_to);

create or replace function loom.freeze_initiative() returns trigger language plpgsql as $$
begin
  if new.baseline is distinct from old.baseline or new.baseline_data_version is distinct from old.baseline_data_version
     or new.baseline_analysis_id is distinct from old.baseline_analysis_id or new.original_proposal is distinct from old.original_proposal
     or new.business_id is distinct from old.business_id or new.opportunity_id is distinct from old.opportunity_id
     or new.artifact_kind is distinct from old.artifact_kind or new.artifact_ref is distinct from old.artifact_ref
     or new.created_at is distinct from old.created_at then
    raise exception 'initiative baseline and original proposal are frozen' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger freeze_initiative before update on loom.initiatives for each row execute function loom.freeze_initiative();
create trigger touch_updated_at before update on loom.initiatives for each row execute function app.touch_updated_at();

create table loom.initiative_executions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  initiative_id uuid not null,
  source text not null check (source in ('connector', 'manual')),
  executed_from date not null,
  executed_to date not null,
  audience_size int check (audience_size is null or audience_size >= 0),
  channel text check (channel is null or length(channel) <= 40),
  actual_cost_minor bigint check (actual_cost_minor is null or actual_cost_minor >= 0),
  note text check (note is null or length(note) <= 1000),
  data jsonb not null default '{}'::jsonb,
  actor_id uuid references users(id),
  created_at timestamptz not null default now(),
  check (executed_to >= executed_from),
  foreign key (business_id, initiative_id) references loom.initiatives (business_id, id)
);
create index initiative_executions_idx on loom.initiative_executions (business_id, initiative_id, created_at);
-- A connector-observed execution (e.g. the LUMA campaign send) is recorded once.
create unique index initiative_executions_connector_once on loom.initiative_executions (initiative_id) where source = 'connector';

create table loom.outcomes (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  initiative_id uuid not null,
  window_from date not null,
  window_to date not null,
  measurement_design text not null,
  measurement_quality text not null check (measurement_quality in ('experimental', 'quasi', 'observational', 'insufficient')),
  causal boolean not null default false,
  primary_metrics jsonb not null default '[]'::jsonb,
  guardrails jsonb not null default '[]'::jsonb,
  attributed jsonb,
  incremental jsonb,
  external_factors jsonb not null default '[]'::jsonb,
  limitations jsonb not null default '[]'::jsonb,
  learnings jsonb not null default '[]'::jsonb,
  data_version text,
  created_at timestamptz not null default now(),
  check (not causal or measurement_quality = 'experimental'),
  unique (initiative_id, window_to),
  foreign key (business_id, initiative_id) references loom.initiatives (business_id, id)
);
create index outcomes_business_idx on loom.outcomes (business_id, created_at desc);

-- ── Change aggregator ───────────────────────────────────────────────────────
create table loom.change_signals (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  type text not null check (type in ('inventory', 'occupancy', 'capacity', 'margin', 'campaign_result')),
  scope text not null check (scope ~ '^[a-z_]+:[A-Za-z0-9_-]{1,80}$'),
  status text not null default 'pending' check (status in ('pending', 'processed', 'not_relevant', 'below_threshold')),
  occurrences int not null default 1,
  suppressed int not null default 0,
  magnitude double precision,
  threshold double precision,
  data jsonb not null default '{}'::jsonb,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  due_at timestamptz not null,
  cooldown_until timestamptz,
  processed_at timestamptz,
  result jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
-- At most one pending signal per key: repeated events aggregate into it.
create unique index change_signals_one_pending on loom.change_signals (business_id, type, scope) where status = 'pending';
create index change_signals_due_idx on loom.change_signals (status, due_at);
create index change_signals_key_idx on loom.change_signals (business_id, type, scope, processed_at desc);

-- ── RLS, grants, append-only ────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['decision_history', 'feedback', 'initiatives', 'initiative_executions', 'outcomes', 'change_signals']
  loop
    execute format('alter table loom.%I enable row level security', t);
    execute format('create policy business_isolation on loom.%I using (app.tenant_visible(business_id)) with check (app.tenant_visible(business_id))', t);
    execute format('grant select, insert, update, delete on loom.%I to {{APP_ROLE}}', t);
  end loop;
  foreach t in array array['decision_history', 'feedback', 'initiative_executions', 'outcomes']
  loop
    execute format('revoke update, delete on loom.%I from {{APP_ROLE}}', t);
    execute format('create trigger append_only before update or delete on loom.%I for each row execute function app.forbid_mutation()', t);
  end loop;
end $$;
-- Initiatives are history: never deleted (cancelled instead).
revoke delete on loom.initiatives from {{APP_ROLE}};
grant execute on function loom.freeze_initiative() to {{APP_ROLE}};

-- ════════════════════════════════════════════════════════════════════════════
-- loom_export.campaign_groups: target and holdout members per campaign with
-- completed bookings (net of refunds), cancellations and refunds created inside
-- the disclosed attribution window — the same definition as LUMA's campaign
-- results endpoint. Aggregates only; no customer ids leave LUMA.
-- ════════════════════════════════════════════════════════════════════════════
create view loom_export.campaign_groups with (security_invoker = true) as
  with g as (
    select e.campaign_id, e.tenant_customer_id as customer_id, case when e.kind = 'holdout' then 'holdout' else 'target' end as grp
    from campaign_events e
    where e.tenant_id = app.current_tenant() and e.kind in ('sent', 'simulated', 'holdout') and e.tenant_customer_id is not null
    group by 1, 2, 3
  )
  select c.id as campaign_id, g.grp, c.attribution_window_days, c.started_at,
         count(distinct g.customer_id)::int as members,
         count(distinct b.tenant_customer_id) filter (where b.status = 'completed')::int as converters,
         count(b.id) filter (where b.status = 'completed')::int as bookings,
         coalesce(sum(b.total_minor - b.refunded_minor) filter (where b.status = 'completed'), 0)::bigint as net_minor,
         count(b.id) filter (where b.status in ('cancelled', 'no_show'))::int as cancelled,
         coalesce(sum(b.refunded_minor), 0)::bigint as refunded_minor
  from campaigns c
  join g on g.campaign_id = c.id
  left join bookings b on b.tenant_id = c.tenant_id and b.tenant_customer_id = g.customer_id and c.started_at is not null
    and b.created_at >= c.started_at and b.created_at < c.started_at + make_interval(days => c.attribution_window_days)
  where c.tenant_id = app.current_tenant()
  group by c.id, g.grp, c.attribution_window_days, c.started_at;

grant select on loom_export.campaign_groups to {{APP_ROLE}};

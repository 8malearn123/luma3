-- ════════════════════════════════════════════════════════════════════════════
-- 0740 Loom Marketing phase 6: learned models and their governance.
-- See docs/LOOM_CORE.md §24 and docs/LOOM_MARKETING_ARCHITECTURE.md §10.4–§10.5.
--
--   loom.model_versions      model registry: one row per trained version
--                            (business model, or sector model with business_id
--                            null) with its training window + data hash, the
--                            temporal split point T, metrics of the model AND
--                            the baseline (and the active version) on the test
--                            period, the promotion-gate result and its status
--                            candidate → shadow → active → retired. Everything
--                            but the status / lifecycle columns is frozen.
--   loom.model_events        append-only audit of every status change
--                            (created, gate, shadow, activation, rollback).
--   loom.model_training_runs append-only record of every training attempt
--                            (trained / ineligible / disabled / insufficient),
--                            with the eligibility check — the UI says why.
--   loom.forecasts           append-only forecasts: from an ACTIVE model
--                            version (enforced by trigger) or a labelled
--                            baseline; value + interval + horizon.
--   loom.shadow_predictions  append-only predictions of a shadow version next
--                            to the reference (active version or baseline),
--                            compared on realised data when the shadow ends.
--
-- Shared-training consent stays an explicit profile fact
-- (`consent.shared_training`, default false, superseded chain = who/when) and
-- is audited; no column is needed here.
--
-- app.apply_conventions() covers schema public only: RLS, grants and the
-- append-only guards for the new loom tables are set explicitly below.
-- Sector models (business_id null) are visible in system scope only
-- (app.tenant_visible(null) is true only for the system scope).
-- ════════════════════════════════════════════════════════════════════════════

create table loom.model_versions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid,
  sector text check (sector is null or sector ~ '^[a-z][a-z0-9_]{1,39}$'),
  model_kind text not null check (model_kind in ('demand_forecast', 'return_probability', 'intervention_response')),
  algorithm text not null check (algorithm ~ '^[a-z][a-z0-9_]{1,59}$'),
  version int not null check (version >= 1),
  status text not null default 'candidate' check (status in ('candidate', 'shadow', 'active', 'retired')),
  train_from date not null,
  train_to date not null,
  split_at date not null,
  test_to date not null,
  data_hash text not null check (length(data_hash) between 8 and 128),
  data_version text,
  params jsonb not null check (jsonb_typeof(params) = 'object'),
  metrics jsonb not null check (jsonb_typeof(metrics) = 'object'),
  gate jsonb not null check (jsonb_typeof(gate) = 'object'),
  shadow_from timestamptz,
  shadow_until timestamptz,
  shadow_result jsonb,
  promoted_by uuid references users(id),
  promoted_at timestamptz,
  retired_at timestamptz,
  retired_reason text check (retired_reason is null or retired_reason in ('gate_failed', 'superseded', 'shadow_failed', 'replaced', 'rollback', 'manual')),
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  -- A business model has a business; a sector model has a sector and no business.
  check (business_id is not null or sector is not null),
  -- Strict temporal split: train ≤ T < test.
  check (train_from <= train_to and train_to <= split_at and test_to > split_at),
  check (status <> 'retired' or retired_at is not null)
);
create unique index model_versions_version_uq on loom.model_versions (coalesce(business_id::text, 'sector:' || sector), model_kind, version);
create unique index model_versions_one_active on loom.model_versions (coalesce(business_id::text, 'sector:' || sector), model_kind) where status = 'active';
create unique index model_versions_one_shadow on loom.model_versions (coalesce(business_id::text, 'sector:' || sector), model_kind) where status = 'shadow';
create index model_versions_business_idx on loom.model_versions (business_id, model_kind, created_at desc);
create index model_versions_shadow_due on loom.model_versions (shadow_until) where status = 'shadow';

/** Frozen training record + valid status transitions (rollback = retired → active of a once-active version). */
create or replace function loom.guard_model_version() returns trigger language plpgsql as $$
begin
  if new.business_id is distinct from old.business_id or new.sector is distinct from old.sector or new.model_kind is distinct from old.model_kind
     or new.algorithm is distinct from old.algorithm or new.version is distinct from old.version or new.train_from is distinct from old.train_from
     or new.train_to is distinct from old.train_to or new.split_at is distinct from old.split_at or new.test_to is distinct from old.test_to
     or new.data_hash is distinct from old.data_hash or new.data_version is distinct from old.data_version or new.params is distinct from old.params
     or new.metrics is distinct from old.metrics or new.gate is distinct from old.gate or new.created_at is distinct from old.created_at
     or new.created_by is distinct from old.created_by then
    raise exception 'model version training record is frozen' using errcode = '42501';
  end if;
  if new.status is distinct from old.status and not (
       (old.status = 'candidate' and new.status in ('shadow', 'retired'))
    or (old.status = 'shadow' and new.status in ('active', 'retired'))
    or (old.status = 'active' and new.status = 'retired')
    or (old.status = 'retired' and new.status = 'active' and old.promoted_at is not null)) then
    raise exception 'invalid model status transition % → %', old.status, new.status using errcode = '23514';
  end if;
  return new;
end $$;
create trigger guard_model_version before update on loom.model_versions for each row execute function loom.guard_model_version();

create table loom.model_events (
  id uuid primary key default gen_random_uuid(),
  business_id uuid,
  model_version_id uuid not null references loom.model_versions(id),
  event text not null check (event in ('created', 'shadow_started', 'activated', 'retired', 'rollback', 'restored', 'shadow_evaluated')),
  from_status text,
  to_status text,
  reason text check (reason is null or length(reason) <= 200),
  data jsonb not null default '{}'::jsonb,
  actor_id uuid references users(id),
  created_at timestamptz not null default now()
);
create index model_events_version_idx on loom.model_events (model_version_id, created_at);
create index model_events_business_idx on loom.model_events (business_id, created_at desc);

create table loom.model_training_runs (
  id uuid primary key default gen_random_uuid(),
  business_id uuid,
  sector text,
  status text not null check (status in ('trained', 'ineligible', 'disabled', 'skipped', 'failed')),
  eligibility jsonb not null default '{}'::jsonb,
  summary jsonb not null default '{}'::jsonb,
  data_version text,
  trigger text not null default 'schedule' check (trigger in ('schedule', 'manual', 'test')),
  actor_id uuid references users(id),
  created_at timestamptz not null default now(),
  check (business_id is not null or sector is not null)
);
create index model_training_runs_idx on loom.model_training_runs (business_id, created_at desc);

create table loom.forecasts (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  batch_id uuid not null,
  model_kind text not null check (model_kind in ('demand_forecast', 'return_probability', 'intervention_response')),
  source text not null check (source in ('model', 'baseline')),
  model_version_id uuid references loom.model_versions(id),
  algorithm text not null,
  subject_key text not null check (length(subject_key) between 1 and 200),
  subject jsonb not null default '{}'::jsonb,
  horizon_from date not null,
  horizon_to date not null,
  value double precision not null,
  interval_low double precision not null,
  interval_high double precision not null,
  unit text not null check (unit in ('count', 'ratio')),
  data_version text,
  analysis_id uuid,
  created_at timestamptz not null default now(),
  check (horizon_to >= horizon_from),
  check (interval_low <= value and value <= interval_high),
  check ((source = 'model') = (model_version_id is not null))
);
create index forecasts_latest_idx on loom.forecasts (business_id, model_kind, created_at desc);
create index forecasts_batch_idx on loom.forecasts (business_id, batch_id);

/** A model forecast is only ever written from the ACTIVE version of its business (never a candidate or shadow). */
create or replace function loom.forecast_from_active() returns trigger language plpgsql as $$
begin
  if new.model_version_id is not null and not exists (
    select 1 from loom.model_versions v where v.id = new.model_version_id and v.status = 'active'
      and v.model_kind = new.model_kind and v.business_id = new.business_id) then
    raise exception 'forecasts come only from an active model version of the business' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger forecast_from_active before insert on loom.forecasts for each row execute function loom.forecast_from_active();

create table loom.shadow_predictions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  model_version_id uuid not null references loom.model_versions(id),
  model_kind text not null,
  reference_source text not null check (reference_source in ('active', 'baseline')),
  reference_version_id uuid references loom.model_versions(id),
  reference_algorithm text not null,
  subject_key text not null check (length(subject_key) between 1 and 200),
  period_from date not null,
  period_to date not null,
  shadow_value double precision not null,
  reference_value double precision not null,
  created_at timestamptz not null default now(),
  check (period_to >= period_from)
);
create index shadow_predictions_idx on loom.shadow_predictions (business_id, model_version_id);

-- ── RLS, grants, append-only ────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['model_versions', 'model_events', 'model_training_runs', 'forecasts', 'shadow_predictions']
  loop
    execute format('alter table loom.%I enable row level security', t);
    execute format('create policy business_isolation on loom.%I using (app.tenant_visible(business_id)) with check (app.tenant_visible(business_id))', t);
    execute format('grant select, insert, update, delete on loom.%I to {{APP_ROLE}}', t);
  end loop;
  foreach t in array array['model_events', 'model_training_runs', 'forecasts', 'shadow_predictions']
  loop
    execute format('revoke update, delete on loom.%I from {{APP_ROLE}}', t);
    execute format('create trigger append_only before update or delete on loom.%I for each row execute function app.forbid_mutation()', t);
  end loop;
end $$;
-- Versions are history: never deleted (retired instead).
revoke delete on loom.model_versions from {{APP_ROLE}};
create trigger no_delete before delete on loom.model_versions for each row execute function app.forbid_mutation();
grant execute on function loom.guard_model_version() to {{APP_ROLE}};
grant execute on function loom.forecast_from_active() to {{APP_ROLE}};

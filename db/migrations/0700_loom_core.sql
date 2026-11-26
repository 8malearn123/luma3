-- ════════════════════════════════════════════════════════════════════════════
-- 0700 Loom Marketing core (phases 1–2), see docs/LOOM_CORE.md and
-- docs/LOOM_MARKETING_ARCHITECTURE.md §4, §5, §6, §8, §14.
--
-- Two schemas:
--   loom_export  read-only, tenant-scoped SECURITY INVOKER views over LUMA's
--                operational tables. They return canonical-shaped, aggregated
--                or pseudonymous rows (no names, phones or e-mails of
--                customers). RLS of the underlying tables applies because the
--                views run as the caller, and every view also filters on
--                app.current_tenant() so system scope reads nothing.
--   loom         Loom's own tables. Every business-owned table carries
--                business_id (= the LUMA tenant id for the LUMA connector) with
--                RLS on it. Loom writes nowhere else.
--
-- Canonical records are NOT stored: each analysis materialises the canonical
-- dataset in memory from loom_export (docs/LOOM_CORE.md "Storage decision").
-- What is stored is the evidence trail: sync runs, quality reports, metric
-- values, opportunities with evidence, checks and events.
--
-- app.apply_conventions() only covers schema public, so grants, RLS and
-- append-only guards for schema loom are set explicitly below. Later
-- migrations that add loom tables must grant them the same way.
-- ════════════════════════════════════════════════════════════════════════════

create schema if not exists loom;
create schema if not exists loom_export;
grant usage on schema loom to {{APP_ROLE}};
grant usage on schema loom_export to {{APP_ROLE}};

-- ── Platform-level settings (one row per key; edited by the platform owner) ──
create table loom.loom_settings (
  key text primary key check (key ~ '^[a-z][a-z0-9_.]{2,63}$'),
  value jsonb not null,
  version int not null default 1,
  updated_by uuid references users(id),
  updated_at timestamptz not null default now()
);

-- ── Connections, sync runs, source mappings ─────────────────────────────────
create table loom.connections (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  kind text not null check (kind ~ '^[a-z][a-z0-9_]{1,31}$'),
  status text not null default 'active' check (status in ('active', 'paused', 'error')),
  config jsonb not null default '{}'::jsonb check (jsonb_typeof(config) = 'object'),
  last_sync_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, kind),
  unique (business_id, id)
);

create table loom.sync_runs (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  connection_id uuid not null,
  analysis_id uuid,
  status text not null check (status in ('succeeded', 'failed')),
  entities jsonb not null default '{}'::jsonb,
  data_version text,
  error text,
  started_at timestamptz not null,
  finished_at timestamptz not null default now(),
  foreign key (business_id, connection_id) references loom.connections (business_id, id)
);
create index sync_runs_business_idx on loom.sync_runs (business_id, finished_at desc);

create table loom.source_mappings (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  connection_id uuid not null,
  entity text not null,
  revenue_basis text,
  status_map jsonb not null default '{}'::jsonb,
  field_map jsonb not null default '{}'::jsonb,
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (connection_id, entity),
  foreign key (business_id, connection_id) references loom.connections (business_id, id)
);

-- ── Analyses (the job record) ───────────────────────────────────────────────
create table loom.analyses (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  kind text not null default 'opportunities' check (kind in ('opportunities')),
  status text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'insufficient_data', 'failed')),
  trigger text not null default 'manual' check (trigger in ('manual', 'schedule', 'seed', 'test')),
  requested_by uuid references users(id),
  period_from date,
  period_to date,
  mode text check (mode in ('standard', 'exploratory')),
  snapshot_hash text,
  data_version text,
  quality_level text check (quality_level in ('ok', 'limited', 'insufficient')),
  result jsonb not null default '{}'::jsonb,
  error_code text,
  error_message text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  unique (business_id, id)
);
create index analyses_business_idx on loom.analyses (business_id, created_at desc);
-- One live analysis per business at a time.
create unique index analyses_one_live on loom.analyses (business_id) where status in ('queued', 'running');

-- ── Data quality reports (append-only) ──────────────────────────────────────
create table loom.data_quality_checks (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  analysis_id uuid,
  overall text not null check (overall in ('ok', 'limited', 'insufficient')),
  domains jsonb not null,
  checks jsonb not null,
  created_at timestamptz not null default now()
);
create index dq_business_idx on loom.data_quality_checks (business_id, created_at desc);

-- ── Metrics registry mirror + values ────────────────────────────────────────
create table loom.metric_definitions (
  key text not null,
  version int not null check (version >= 1),
  label_ar text not null,
  label_en text not null,
  unit text not null,
  grain text[] not null,
  time_window text not null,
  formula text not null,
  requires text[] not null default '{}',
  min_sample int not null default 0,
  sectors text[] not null default '{*}',
  definition_hash text not null,
  created_at timestamptz not null default now(),
  primary key (key, version)
);

create table loom.metric_values (
  id bigint generated always as identity primary key,
  business_id uuid not null,
  analysis_id uuid not null,
  metric_key text not null,
  metric_version int not null,
  grain_ref text not null,
  value double precision,
  n int,
  status text not null check (status in ('ok', 'insufficient_sample', 'missing_input')),
  period_from date,
  period_to date,
  created_at timestamptz not null default now(),
  foreign key (metric_key, metric_version) references loom.metric_definitions (key, version)
);
create index metric_values_analysis_idx on loom.metric_values (business_id, analysis_id);

-- ── Business profile facts and goals ────────────────────────────────────────
create table loom.business_profile_facts (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  key text not null check (key ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_:-]+)+$' and length(key) <= 120),
  value jsonb not null,
  kind text not null check (kind in ('computed', 'explicit', 'inferred')),
  source_type text not null check (source_type in ('metric', 'user', 'connector', 'model')),
  source_ref text,
  confidence text check (confidence in ('high', 'medium', 'low')),
  needs_review boolean not null default false,
  valid_from timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references users(id),
  superseded_by uuid,
  superseded_at timestamptz,
  check (confidence is null or kind = 'inferred')
);
create unique index profile_facts_current on loom.business_profile_facts (business_id, key, kind) where superseded_by is null;
create index profile_facts_business_idx on loom.business_profile_facts (business_id, key);

create table loom.business_goals (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  kind text not null check (kind in ('fill_quiet_times', 'reactivate_customers', 'grow_offerings', 'increase_margin',
    'increase_conversion', 'grow_new_customers', 'sell_products', 'improve_reviews')),
  priority text not null check (priority in ('primary', 'secondary')),
  offering_ids uuid[] not null default '{}',
  note text check (note is null or length(note) <= 300),
  status text not null default 'active' check (status in ('active', 'archived')),
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index business_goals_idx on loom.business_goals (business_id, status);

-- ── Opportunities ───────────────────────────────────────────────────────────
create table loom.opportunities (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  fingerprint text not null,
  detector_id text not null,
  category text not null check (category in ('quiet_capacity', 'high_satisfaction_low_demand', 'lapsed_cohort', 'unserved_demand',
    'conversion_friction', 'cross_sell_affinity', 'slow_mover_bundle', 'margin_leak', 'missing_cost_blocker',
    'offering_presentation', 'loyalty_over_discount', 'capacity_prerequisite', 'campaign_learning')),
  status text not null check (status in ('detected', 'assessed', 'proposed', 'studying', 'deferred', 'dismissed', 'accepted',
    'converted', 'executed', 'measured', 'closed', 'superseded', 'expired')),
  parent_id uuid references loom.opportunities (id),
  first_analysis_id uuid,
  last_analysis_id uuid,
  subject jsonb not null default '{}'::jsonb,
  card jsonb not null,
  priority_rank int,
  priority_score double precision,
  display_bucket text check (display_bucket in ('top', 'study', 'blocked')),
  evidence_strength text check (evidence_strength in ('strong', 'moderate', 'limited', 'insufficient')),
  data_quality text check (data_quality in ('ok', 'limited', 'insufficient')),
  sector_pack text not null default 'beauty',
  sector_pack_version text not null,
  period_from date,
  period_to date,
  review_at date,
  deferred_until date,
  decided_at timestamptz,
  decided_by uuid references users(id),
  decision_reason text check (decision_reason in ('capacity_staffing', 'capacity_inventory', 'budget', 'brand_fit', 'timing',
    'already_doing', 'disagree_with_data', 'not_valuable', 'other')),
  decision_note text check (decision_note is null or length(decision_note) <= 1000),
  conversion jsonb,
  detected_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, fingerprint),
  unique (business_id, id)
);
create index opportunities_business_idx on loom.opportunities (business_id, status, priority_rank);

-- Evidence ids are opaque 'ev_…' strings so cards and plans can cite them.
create table loom.opportunity_evidence (
  id text primary key check (id ~ '^ev_[a-z0-9]{8,40}$'),
  business_id uuid not null,
  opportunity_id uuid not null,
  analysis_id uuid,
  metric_key text not null,
  metric_version int,
  grain_ref text not null,
  value double precision,
  n int,
  label jsonb not null,
  grade text not null check (grade in ('observed', 'inferred', 'assumption')),
  created_at timestamptz not null default now(),
  foreign key (business_id, opportunity_id) references loom.opportunities (business_id, id)
);
create index opp_evidence_idx on loom.opportunity_evidence (business_id, opportunity_id);

create table loom.opportunity_checks (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  opportunity_id uuid not null,
  analysis_id uuid,
  check_type text not null check (check_type in ('capacity', 'inventory', 'margin', 'preferences', 'conflicts')),
  status text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  foreign key (business_id, opportunity_id) references loom.opportunities (business_id, id)
);
create index opp_checks_idx on loom.opportunity_checks (business_id, opportunity_id, created_at desc);

create table loom.opportunity_events (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  opportunity_id uuid not null,
  analysis_id uuid,
  event text not null check (event in ('detected', 'reassessed', 'proposed', 'viewed', 'decided', 'converted', 'expired',
    'superseded', 'reopened', 'executed', 'measured', 'closed')),
  from_status text,
  to_status text,
  reason text,
  note text,
  counts_as_idea_failure boolean,
  data jsonb not null default '{}'::jsonb,
  actor_id uuid references users(id),
  created_at timestamptz not null default now(),
  foreign key (business_id, opportunity_id) references loom.opportunities (business_id, id)
);
create index opp_events_idx on loom.opportunity_events (business_id, opportunity_id, created_at);

-- ── RLS, grants, append-only ────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['connections', 'sync_runs', 'source_mappings', 'analyses', 'data_quality_checks', 'metric_values',
    'business_profile_facts', 'business_goals', 'opportunities', 'opportunity_evidence', 'opportunity_checks', 'opportunity_events']
  loop
    execute format('alter table loom.%I enable row level security', t);
    execute format('create policy business_isolation on loom.%I using (app.tenant_visible(business_id)) with check (app.tenant_visible(business_id))', t);
  end loop;
  foreach t in array array['connections', 'source_mappings', 'business_profile_facts', 'business_goals', 'opportunities']
  loop
    execute format('create trigger touch_updated_at before update on loom.%I for each row execute function app.touch_updated_at()', t);
  end loop;
end $$;

-- Global tables: readable by every scope, written only in system scope.
alter table loom.loom_settings enable row level security;
create policy read_all on loom.loom_settings for select using (true);
create policy system_write on loom.loom_settings for all using (app.is_system()) with check (app.is_system());
alter table loom.metric_definitions enable row level security;
create policy read_all on loom.metric_definitions for select using (true);
create policy system_write on loom.metric_definitions for insert with check (app.is_system());

grant select, insert, update, delete on all tables in schema loom to {{APP_ROLE}};
grant usage, select on all sequences in schema loom to {{APP_ROLE}};

do $$
declare t text;
begin
  foreach t in array array['sync_runs', 'data_quality_checks', 'metric_definitions', 'metric_values', 'opportunity_evidence',
    'opportunity_checks', 'opportunity_events']
  loop
    execute format('revoke update, delete on loom.%I from {{APP_ROLE}}', t);
    execute format('create trigger append_only before update or delete on loom.%I for each row execute function app.forbid_mutation()', t);
  end loop;
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- loom_export: read-only canonical views for the in-process LUMA connector.
-- ════════════════════════════════════════════════════════════════════════════

-- Pseudonymous customer reference (never the row id, name or contact).
create or replace function loom_export.pseudo(id uuid) returns text
language sql immutable as $$ select 'c_' || substr(md5('loom:' || id::text), 1, 20) $$;

create view loom_export.business with (security_invoker = true) as
  select t.id, 'beauty'::text as sector, t.business_type as subsector, t.city, t.timezone, t.currency,
         t.default_locale as locale, t.status, t.created_at
  from tenants t where t.id = app.current_tenant();

create view loom_export.locations with (security_invoker = true) as
  select b.id, b.name, b.city, b.timezone, b.status, b.is_primary
  from branches b where b.tenant_id = app.current_tenant();

create view loom_export.offerings with (security_invoker = true) as
  select s.id, 'service'::text as kind, 'service'::text as source_kind, s.name_ar, s.name_en, s.price_minor,
         case when s.archived_at is not null then 'archived' when s.is_active then 'active' else 'inactive' end as status,
         s.category_id, s.duration_min, s.buffer_before_min + s.buffer_after_min as buffer_min,
         s.image_asset_id is not null as has_image, coalesce(s.description_ar, s.description_en) is not null as has_description,
         s.cost_minor as recorded_cost_minor, s.is_visible, null::uuid as product_id, s.branch_id as location_id,
         s.updated_at, s.created_at
    from services s where s.tenant_id = app.current_tenant()
  union all
  select v.id, 'product', 'product_variant', coalesce(p.name_ar, '') || coalesce(' · ' || v.name_ar, ''), coalesce(p.name_en, '') || coalesce(' · ' || v.name_en, ''),
         v.price_minor, case when p.status = 'archived' then 'archived' when v.is_active and p.status = 'active' then 'active' else 'inactive' end,
         p.category_id, null::int, 0, exists (select 1 from product_images pi where pi.product_id = p.id and pi.tenant_id = p.tenant_id),
         coalesce(p.description_ar, p.description_en) is not null, v.cost_minor, p.is_visible, p.id, null::uuid, greatest(v.updated_at, p.updated_at), v.created_at
    from product_variants v join products p on p.id = v.product_id and p.tenant_id = v.tenant_id
    where v.tenant_id = app.current_tenant()
  union all
  select k.id, 'package', 'service_package', k.name_ar, k.name_en, k.price_minor,
         case when k.archived_at is not null then 'archived' when k.is_active then 'active' else 'inactive' end,
         null::uuid, null::int, 0, false, coalesce(k.description_ar, k.description_en) is not null, null::bigint, k.is_visible, null::uuid, null::uuid,
         k.updated_at, k.created_at
    from service_packages k where k.tenant_id = app.current_tenant()
  union all
  select m.id, 'membership', 'membership_plan', m.name_ar, m.name_en, m.price_minor, case when m.is_active then 'active' else 'inactive' end,
         null::uuid, null::int, 0, false, coalesce(m.description_ar, m.description_en) is not null, null::bigint, m.is_visible, null::uuid, null::uuid,
         m.updated_at, m.created_at
    from membership_plans m where m.tenant_id = app.current_tenant();

-- What a service needs: materials (recipes), skills (qualified staff), time, resources.
create view loom_export.offering_requirements with (security_invoker = true) as
  select r.service_id as offering_id, 'material'::text as type, r.inventory_item_id as ref_id, r.quantity::float8 as quantity, r.unit,
         case when r.approved_at is not null then 'recipe' else 'estimated' end as confidence
    from service_material_recipes r where r.tenant_id = app.current_tenant()
  union all
  select ss.service_id, 'skill', ss.staff_id, coalesce(ss.duration_override_min, s.duration_min)::float8, 'min', 'recipe'
    from service_staff ss join services s on s.id = ss.service_id and s.tenant_id = ss.tenant_id
    where ss.tenant_id = app.current_tenant()
  union all
  select s.id, 'time', null::uuid, (s.duration_min + s.buffer_before_min + s.buffer_after_min)::float8, 'min', 'recipe'
    from services s where s.tenant_id = app.current_tenant()
  union all
  select q.service_id, 'resource', q.resource_type_id, q.quantity::float8, 'unit', 'recipe'
    from service_resource_requirements q where q.tenant_id = app.current_tenant()
  union all
  select pi.package_id, 'component', pi.service_id, 1::float8, 'unit', 'recipe'
    from service_package_items pi where pi.tenant_id = app.current_tenant();

create view loom_export.inventory_items with (security_invoker = true) as
  select i.id, i.name, case i.kind when 'retail' then 'sellable' when 'material' then 'consumable' else 'both' end as usage,
         i.on_hand::float8 as on_hand, i.reserved::float8 as reserved, i.unit, i.cost_per_unit_minor as unit_cost_minor,
         i.low_stock_threshold::float8 as reorder_level, i.variant_id as offering_id, i.branch_id as location_id, i.is_active,
         coalesce((select sum(-m.quantity) from stock_movements m where m.inventory_item_id = i.id and m.tenant_id = i.tenant_id
                    and m.kind = 'consumption' and m.created_at > now() - interval '90 days'), 0)::float8 as consumed_90d,
         coalesce((select sum(-m.quantity) from stock_movements m where m.inventory_item_id = i.id and m.tenant_id = i.tenant_id
                    and m.kind = 'sale' and m.created_at > now() - interval '90 days'), 0)::float8 as sold_90d,
         i.updated_at
  from inventory_items i where i.tenant_id = app.current_tenant();

create view loom_export.resources with (security_invoker = true) as
  select sp.id, 'staff'::text as kind, null::uuid as resource_type_id,
         (select min(a.branch_id::text)::uuid from staff_branch_assignments a where a.staff_id = sp.id and a.tenant_id = sp.tenant_id) as location_id,
         (sp.archived_at is null and sp.is_active) as is_active
    from staff_profiles sp where sp.tenant_id = app.current_tenant()
  union all
  select r.id, 'room', r.resource_type_id, r.branch_id, r.is_active
    from resources r where r.tenant_id = app.current_tenant();

-- Schedule primitives; the connector turns them into CapacityWindow records.
create view loom_export.staff_hours with (security_invoker = true) as
  select w.staff_id as resource_id, w.weekday, w.start_time::text as start_time, w.end_time::text as end_time,
         w.effective_from, w.effective_to, b.timezone
  from working_hours w join branches b on b.id = w.branch_id and b.tenant_id = w.tenant_id
  where w.tenant_id = app.current_tenant();

create view loom_export.staff_breaks with (security_invoker = true) as
  select x.staff_id as resource_id, x.weekday, x.on_date, x.start_time::text as start_time, x.end_time::text as end_time
  from staff_breaks x where x.tenant_id = app.current_tenant();

create view loom_export.shift_overrides with (security_invoker = true) as
  select o.staff_id as resource_id, o.on_date, o.kind, o.start_time::text as start_time, o.end_time::text as end_time, b.timezone
  from shift_overrides o join branches b on b.id = o.branch_id and b.tenant_id = o.tenant_id
  where o.tenant_id = app.current_tenant() and o.on_date between current_date - 45 and current_date + 45;

-- Approved leave only (a capacity constraint); requested leave is not capacity.
create view loom_export.staff_leave with (security_invoker = true) as
  select l.staff_id as resource_id, lower(l.during) as starts_at, upper(l.during) as ends_at
  from leave_requests l where l.tenant_id = app.current_tenant() and l.status = 'approved'
    and l.during && tstzrange(now() - interval '45 days', now() + interval '45 days');

create view loom_export.time_blocks with (security_invoker = true) as
  select coalesce(t.staff_id, t.resource_id) as resource_id, (t.staff_id is not null) as is_staff, lower(t.during) as starts_at, upper(t.during) as ends_at
  from time_blocks t where t.tenant_id = app.current_tenant()
    and t.during && tstzrange(now() - interval '45 days', now() + interval '45 days');

create view loom_export.booked_intervals with (security_invoker = true) as
  select bi.staff_id as resource_id, bi.starts_at, bi.ends_at, bi.service_id as offering_id
  from booking_items bi join bookings bk on bk.id = bi.booking_id and bk.tenant_id = bi.tenant_id
  where bi.tenant_id = app.current_tenant() and bi.superseded_at is null
    and bk.status in ('confirmed', 'checked_in', 'in_service', 'completed')
    and bi.starts_at < now() + interval '45 days' and bi.ends_at > now() - interval '45 days';

-- Transactions (bookings and product orders) with source statuses; the
-- connector normalises them (source_mappings.status_map).
create view loom_export.transactions with (security_invoker = true) as
  select bk.id, 'booking'::text as kind, bk.status as source_status, bk.cancel_source,
         bk.channel, bk.source as origin, loom_export.pseudo(bk.tenant_customer_id) as customer_ref,
         bk.subtotal_minor, bk.discount_minor, bk.tax_minor, bk.total_minor, bk.refunded_minor,
         bk.starts_at as occurred_at, bk.campaign_id, bk.marketplace_fee_bp, bk.coupon_id is not null as has_coupon,
         (select coalesce(sum(mc.fee_minor), 0) from marketplace_commissions mc where mc.booking_id = bk.id and mc.tenant_id = bk.tenant_id)::bigint as platform_fee_minor,
         bk.updated_at
    from bookings bk where bk.tenant_id = app.current_tenant() and bk.starts_at > now() - interval '730 days'
  union all
  select o.id, 'order', o.status, case when o.cancelled_by is not null and o.cancelled_by = o.customer_user_id then 'customer' when o.status = 'cancelled' then 'business' end,
         'direct', 'order', loom_export.pseudo(o.tenant_customer_id),
         o.subtotal_minor, o.discount_minor, o.tax_minor, o.total_minor, o.refunded_minor,
         o.created_at, o.campaign_id, null::int, o.coupon_id is not null, 0::bigint, o.updated_at
    from orders o where o.tenant_id = app.current_tenant() and o.created_at > now() - interval '730 days';

create view loom_export.transaction_lines with (security_invoker = true) as
  select bi.id, bi.booking_id as transaction_id, bi.service_id as offering_id, bi.staff_id as resource_id, 1::float8 as qty,
         bi.line_total_minor, null::bigint as unit_cost_minor, bi.starts_at, bi.duration_min
    from booking_items bi where bi.tenant_id = app.current_tenant() and bi.superseded_at is null and bi.starts_at > now() - interval '730 days'
  union all
  select oi.id, oi.order_id, oi.variant_id, null::uuid, oi.quantity::float8, oi.line_total_minor, oi.unit_cost_minor, oi.created_at, null::int
    from order_items oi where oi.tenant_id = app.current_tenant() and oi.created_at > now() - interval '730 days';

-- Payroll commission policy (docs/PAYROLL.md): category rate + tiers + count of per-staff overrides.
create view loom_export.commission_policies with (security_invoker = true) as
  select c.category, c.enabled, c.rate_bp, c.tiers,
         (select count(*) from staff_commission_overrides x where x.tenant_id = c.tenant_id and x.category = c.category)::int as staff_overrides,
         (select max(x.rate_bp) from staff_commission_overrides x where x.tenant_id = c.tenant_id and x.category = c.category and x.enabled)::int as max_override_bp
  from commission_policies c where c.tenant_id = app.current_tenant();

-- Payment-level fees recorded by LUMA (marketplace split fee on online payments).
create view loom_export.payment_fees with (security_invoker = true) as
  select p.booking_id as transaction_id, sum(p.platform_fee_minor)::bigint as platform_fee_minor, sum(p.amount_minor)::bigint as amount_minor
  from payments p where p.tenant_id = app.current_tenant() and p.status = 'captured' and p.booking_id is not null
    and p.created_at > now() - interval '400 days'
  group by p.booking_id;

-- Demand signals aggregated per local day, type and offering (no session ids).
create view loom_export.demand_signals with (security_invoker = true) as
  select case e.type when 'service_view' then 'view' when 'product_view' then 'view' when 'booking_start' then 'booking_start'
           when 'availability_empty' then 'no_availability' when 'waitlist_join' then 'waitlist' when 'checkout_start' then 'booking_start'
           when 'booking_confirmed' then 'confirmed' when 'page_view' then 'page_view' end as type,
         e.entity_id as offering_id, date_trunc('day', e.occurred_at) as day, count(*)::int as events, count(distinct e.session_id)::int as sessions
  from analytics_events e
  where e.tenant_id = app.current_tenant() and not e.is_excluded and e.occurred_at > now() - interval '120 days'
    and e.type in ('service_view', 'product_view', 'booking_start', 'availability_empty', 'waitlist_join', 'checkout_start', 'booking_confirmed', 'page_view')
  group by 1, 2, 3
  union all
  select 'waitlist_entry', w.service_id, date_trunc('day', w.created_at), count(*)::int, count(*)::int
  from waitlist_entries w where w.tenant_id = app.current_tenant() and w.created_at > now() - interval '120 days'
  group by 2, 3;

create view loom_export.reviews with (security_invoker = true) as
  select r.id, r.rating, (select bi.service_id from booking_items bi where bi.booking_id = r.booking_id and bi.tenant_id = r.tenant_id order by bi.sequence limit 1) as offering_id,
         r.staff_id as resource_id, true as verified, r.created_at as at
  from reviews r where r.tenant_id = app.current_tenant() and r.status <> 'hidden' and r.created_at > now() - interval '400 days';

create view loom_export.complaints with (security_invoker = true) as
  select i.id, i.type, i.status = 'confirmed' as verified, i.occurred_at as at,
         (select bi.service_id from booking_items bi where bi.booking_id = i.booking_id and bi.tenant_id = i.tenant_id order by bi.sequence limit 1) as offering_id
  from customer_incidents i where i.tenant_id = app.current_tenant() and i.type = 'conduct' and i.occurred_at > now() - interval '400 days';

-- Pseudonymous customers: no names or contacts; dup_key is a one-way hash of the normalised contact.
create view loom_export.customers with (security_invoker = true) as
  select loom_export.pseudo(c.id) as ref, c.created_at, c.first_visit_at, c.last_visit_at, c.status,
         c.acquisition_source, c.source as origin,
         (select count(*) from bookings b where b.tenant_customer_id = c.id and b.tenant_id = c.tenant_id and b.status = 'completed')::int as visits,
         (select coalesce(jsonb_object_agg(x.channel, x.granted), '{}'::jsonb) from (
            select distinct on (cc.channel) cc.channel, cc.granted from customer_consents cc
            where cc.tenant_id = c.tenant_id and cc.tenant_customer_id = c.id and cc.purpose = 'marketing'
            order by cc.channel, cc.recorded_at desc) x) as consents,
         case when coalesce(c.phone, c.email) is null then null
              else substr(md5(lower(regexp_replace(coalesce(c.phone, c.email), '[^0-9a-zA-Z@.]', '', 'g'))), 1, 16) end as dup_key,
         c.updated_at
  from tenant_customers c where c.tenant_id = app.current_tenant() and c.archived_at is null;

create view loom_export.campaigns with (security_invoker = true) as
  select c.id, c.channel, c.status, c.holdout_bp, c.started_at, c.finished_at, c.created_at,
         (select count(*) from campaign_events e where e.campaign_id = c.id and e.tenant_id = c.tenant_id and e.kind in ('sent', 'simulated'))::int as targeted,
         (select count(*) from campaign_events e where e.campaign_id = c.id and e.tenant_id = c.tenant_id and e.kind = 'holdout')::int as holdout,
         (select count(*) from campaign_events e where e.campaign_id = c.id and e.tenant_id = c.tenant_id and e.kind = 'converted')::int as conversions,
         (select coalesce(sum(e.value_minor), 0) from campaign_events e where e.campaign_id = c.id and e.tenant_id = c.tenant_id and e.kind = 'converted')::bigint as attributed_net_minor
  from campaigns c where c.tenant_id = app.current_tenant();

create view loom_export.calendar_events with (security_invoker = true) as
  select e.id, e.title, e.kind, e.starts_on, e.ends_on, e.source_url is not null as has_source
  from marketing_calendar_events e where e.tenant_id = app.current_tenant();

create view loom_export.market_signals with (security_invoker = true) as
  select o.id, o.title, o.topic, o.region, o.published_at, o.observed_at, o.evidence_strength
  from trend_observations o where o.tenant_id = app.current_tenant() and o.observed_at > now() - interval '120 days';

create view loom_export.marketing_preferences with (security_invoker = true) as
  select p.max_discount_bp, p.monthly_budget_minor, p.goals, p.tone, p.channels, p.promote_products, p.updated_at
  from marketing_preferences p where p.tenant_id = app.current_tenant();

grant select on all tables in schema loom_export to {{APP_ROLE}};
grant execute on all functions in schema loom_export to {{APP_ROLE}};

-- ════════════════════════════════════════════════════════════════════════════
-- 0710 Loom Marketing phase 3: planner, validator v2, plans from opportunities,
-- knowledge layer (playbooks + citations), opportunity comments.
-- See docs/LOOM_CORE.md §10–§13 and docs/LOOM_MARKETING_ARCHITECTURE.md §6.9,
-- §6.10, §9, §11.2, §11.3.
--
-- app.apply_conventions() covers schema public only: every loom table below
-- sets its own RLS, grants and append-only guards (same pattern as 0700).
-- ════════════════════════════════════════════════════════════════════════════

-- Model tier per prompt (§6.9 "اختيار النموذج حسب المهمة"): standard wording vs
-- strong plan assembly. Existing rows keep NULL (= standard).
alter table prompt_versions add column if not exists model_tier text
  check (model_tier is null or model_tier in ('standard', 'strong'));

-- ── Knowledge units (§9): global, versioned, insert-only ───────────────────
-- Rows are mirrored from the curated library in src/loom/knowledge/units/*.json
-- (code is the source of truth; a changed unit is a new version row).
create table loom.knowledge_units (
  id text not null check (id ~ '^pb\.[a-z0-9_.]{3,80}$'),
  version int not null check (version >= 1),
  sectors text[] not null check (cardinality(sectors) >= 1),
  detectors text[] not null default '{}',
  interventions text[] not null default '{}',
  channels text[] not null default '{}',
  title jsonb not null,
  guidance jsonb not null,
  when_not_to_use jsonb not null,
  common_mistakes jsonb not null default '[]'::jsonb,
  measurement jsonb not null,
  examples jsonb not null,
  source jsonb not null,
  reviewed_at date not null,
  owner text not null,
  content_hash text not null,
  created_at timestamptz not null default now(),
  primary key (id, version)
);
create index knowledge_units_sectors_idx on loom.knowledge_units using gin (sectors);
create index knowledge_units_detectors_idx on loom.knowledge_units using gin (detectors);

-- ── Planner runs: one row per plan generation / revision proposal ──────────
create table loom.planner_runs (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  kind text not null check (kind in ('monthly', 'weekly', 'revision')),
  status text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'insufficient_data', 'failed')),
  trigger text not null default 'manual' check (trigger in ('manual', 'schedule', 'change', 'seed', 'test')),
  mode text not null default 'auto' check (mode in ('auto', 'rules')),
  period_from date,
  period_to date,
  analysis_id uuid,
  source text check (source in ('ai', 'rules')),
  ai_reason text,
  ai_run_id uuid,
  prompt_version text,
  model text,
  candidates_hash text,
  plan_id uuid,
  plan_version_id uuid,
  reason jsonb,
  validation jsonb not null default '{}'::jsonb,
  result jsonb not null default '{}'::jsonb,
  error_code text,
  error_message text,
  requested_by uuid references users(id),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);
create index planner_runs_business_idx on loom.planner_runs (business_id, created_at desc);
create unique index planner_runs_one_live on loom.planner_runs (business_id, kind) where status in ('queued', 'running');

-- ── Plan actions as rows (§11.2), linked to an immutable plan version ──────
-- The plan and its versions stay in LUMA (marketing_plans / plan_versions,
-- written only through the host's PlanPort); Loom keeps the structured
-- actions with their opportunity, checks, materials and slots.
create table loom.plan_actions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  plan_id uuid not null references marketing_plans (id),
  plan_version_id uuid not null references plan_versions (id),
  planner_run_id uuid references loom.planner_runs (id),
  opportunity_id uuid,
  plan_kind text not null check (plan_kind in ('monthly', 'weekly')),
  seq int not null check (seq >= 1),
  ref text not null check (ref ~ '^la_[a-z0-9_]{1,40}$'),
  action_kind text not null check (action_kind in ('content', 'package', 'value_add', 'reminder', 'open_slots', 'booking_ux',
    'loyalty', 'limited_discount', 'price_review', 'staffing', 'restock')),
  intervention_id text,
  role text not null default 'initiative' check (role in ('initiative', 'prerequisite', 'measurement')),
  title jsonb not null,
  description jsonb not null,
  content_idea jsonb,
  audience jsonb not null default '{}'::jsonb,
  channels text[] not null default '{}',
  schedule_from date,
  schedule_to date,
  owner jsonb not null,
  budget_minor bigint check (budget_minor is null or budget_minor >= 0),
  budget_basis text not null default 'unknown' check (budget_basis in ('computed', 'assumption', 'unknown')),
  operational jsonb not null default '{}'::jsonb,
  highlighted jsonb not null default '[]'::jsonb,
  success_metrics jsonb not null default '[]'::jsonb,
  evidence_refs text[] not null default '{}',
  knowledge_refs text[] not null default '{}',
  revision_note jsonb,
  created_at timestamptz not null default now(),
  unique (plan_version_id, ref),
  foreign key (business_id, opportunity_id) references loom.opportunities (business_id, id)
);
create index plan_actions_version_idx on loom.plan_actions (business_id, plan_version_id, seq);
create index plan_actions_opportunity_idx on loom.plan_actions (business_id, opportunity_id);

-- ── Knowledge citations (§9): every use of a unit by a card or plan item ───
create table loom.knowledge_citations (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  unit_id text not null,
  unit_version int not null,
  opportunity_id uuid,
  plan_action_id uuid references loom.plan_actions (id),
  planner_run_id uuid references loom.planner_runs (id),
  item_ref text not null,
  used_by text not null check (used_by in ('planner_ai', 'rules')),
  created_at timestamptz not null default now(),
  foreign key (unit_id, unit_version) references loom.knowledge_units (id, version),
  foreign key (business_id, opportunity_id) references loom.opportunities (business_id, id)
);
create index knowledge_citations_idx on loom.knowledge_citations (business_id, opportunity_id, created_at desc);

-- ── Notes on opportunities (generalises plan_comments, §11.3) ──────────────
create table loom.opportunity_comments (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  opportunity_id uuid not null,
  author_id uuid not null references users (id),
  body text not null check (length(body) between 1 and 2000),
  created_at timestamptz not null default now(),
  foreign key (business_id, opportunity_id) references loom.opportunities (business_id, id)
);
create index opportunity_comments_idx on loom.opportunity_comments (business_id, opportunity_id, created_at);

-- ── Planner wording on the card (AI or rules), kept apart from the engine card ──
-- The engine rewrites `card` on every analysis; `wording` holds the latest
-- validated planner text (bilingual) with its provenance and knowledge refs.
alter table loom.opportunities add column if not exists wording jsonb;

-- ── RLS, grants, append-only ────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['planner_runs', 'plan_actions', 'knowledge_citations', 'opportunity_comments']
  loop
    execute format('alter table loom.%I enable row level security', t);
    execute format('create policy business_isolation on loom.%I using (app.tenant_visible(business_id)) with check (app.tenant_visible(business_id))', t);
  end loop;
end $$;

alter table loom.knowledge_units enable row level security;
create policy read_all on loom.knowledge_units for select using (true);
create policy system_write on loom.knowledge_units for insert with check (app.is_system());

grant select, insert, update, delete on loom.planner_runs, loom.plan_actions, loom.knowledge_citations, loom.opportunity_comments, loom.knowledge_units to {{APP_ROLE}};

do $$
declare t text;
begin
  foreach t in array array['knowledge_units', 'plan_actions', 'knowledge_citations', 'opportunity_comments']
  loop
    execute format('revoke update, delete on loom.%I from {{APP_ROLE}}', t);
    execute format('create trigger append_only before update or delete on loom.%I for each row execute function app.forbid_mutation()', t);
  end loop;
end $$;

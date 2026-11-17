-- ════════════════════════════════════════════════════════════════════════════
-- 0720 Loom Marketing phase 4: radar, timing and market (docs/LOOM_CORE.md §10,
-- docs/LOOM_MARKETING_ARCHITECTURE.md §12, §14).
--
-- Business tables (business_id + RLS app.tenant_visible):
--   signal_sources        RSS / user_link / api sources of one business
--   signals               normalised external items (append-only; text is
--                         third-party and stored as untrusted_*)
--   signal_clusters       deterministic clusters of related signals with
--                         evidence class, validity, relevance and decision
--   calendar_choices      a business adopts or hides a platform event
--   timing_attachments    an event or a cluster attached to an EXISTING
--                         internal opportunity (P1: never a standalone one)
--   market_observations   competitor offers, price points, audience needs,
--                         channel norms with comparability
-- Platform tables (read by every scope, written only in system scope):
--   platform_calendar_events  official imports, the curated starter calendar
--                             and platform-owner reviews
--   official_source_state     fetch state / backoff per registry source
--
-- app.apply_conventions() covers schema public only, so RLS, grants and the
-- append-only guard are set explicitly below (docs/LOOM_CORE.md §2).
-- ════════════════════════════════════════════════════════════════════════════

-- ── Business signal sources ─────────────────────────────────────────────────
create table loom.signal_sources (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  kind text not null check (kind in ('rss', 'user_link', 'api')),
  provider text check (provider is null or provider ~ '^[a-z][a-z0-9_]{1,39}$'),
  name text not null check (length(name) between 2 and 120),
  url text check (url is null or (url ~ '^https://' and length(url) <= 500)),
  query jsonb not null default '{}'::jsonb check (jsonb_typeof(query) = 'object'),
  access_basis text not null check (length(access_basis) between 2 and 300),
  status text not null default 'active' check (status in ('active', 'disabled', 'error', 'disconnected')),
  last_fetched_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  consecutive_failures int not null default 0 check (consecutive_failures >= 0),
  next_fetch_at timestamptz not null default now(),
  legacy_trend_source_id uuid,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((kind = 'api') = (provider is not null)),
  check (kind = 'api' or url is not null),
  unique (business_id, id)
);
create unique index signal_sources_url_uq on loom.signal_sources (business_id, url) where url is not null;
create index signal_sources_due_idx on loom.signal_sources (next_fetch_at) where status in ('active', 'error');

-- ── Signals (append-only) ───────────────────────────────────────────────────
create table loom.signals (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  source_id uuid not null,
  url text not null check (url ~ '^https://' and length(url) <= 500),
  untrusted_title text not null check (length(untrusted_title) between 1 and 300),
  untrusted_summary text check (untrusted_summary is null or length(untrusted_summary) <= 600),
  published_at timestamptz,
  observed_at timestamptz not null default now(),
  region text check (region is null or length(region) <= 40),
  topic text check (topic is null or topic ~ '^[a-z][a-z0-9_]{1,39}$'),
  title_tokens text[] not null default '{}',
  -- Only what the source itself provides; NULL otherwise (never estimated).
  reach_metrics jsonb check (reach_metrics is null or jsonb_typeof(reach_metrics) = 'object'),
  evidence_class text not null check (evidence_class in ('example', 'early_signal', 'supported_trend')),
  valid_until date,
  content_hash text not null,
  dedupe_key text not null,
  duplicate_of uuid references loom.signals (id),
  created_at timestamptz not null default now(),
  unique (source_id, content_hash),
  unique (business_id, id),
  foreign key (business_id, source_id) references loom.signal_sources (business_id, id) on delete cascade
);
create index signals_business_idx on loom.signals (business_id, published_at desc);
create index signals_dedupe_idx on loom.signals (business_id, dedupe_key);

-- ── Clusters ────────────────────────────────────────────────────────────────
create table loom.signal_clusters (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  cluster_key text not null check (length(cluster_key) between 4 and 120),
  topic text,
  untrusted_label text not null check (length(untrusted_label) <= 300),
  signal_ids uuid[] not null default '{}',
  signal_count int not null default 0,
  source_count int not null default 0,
  live_count int not null default 0,
  evidence_class text not null check (evidence_class in ('example', 'early_signal', 'supported_trend')),
  liveness text not null check (liveness in ('live', 'stale')),
  first_published_at timestamptz,
  last_published_at timestamptz,
  valid_until date,
  relevance jsonb not null default '{}'::jsonb,
  relevance_score double precision,
  status text not null default 'open' check (status in ('open', 'dismissed', 'attached', 'merged')),
  opportunity_id uuid,
  planned_ref text,
  decided_by uuid references users(id),
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, cluster_key),
  unique (business_id, id),
  foreign key (business_id, opportunity_id) references loom.opportunities (business_id, id)
);
create index signal_clusters_business_idx on loom.signal_clusters (business_id, status, liveness);

-- ── Platform calendar (global) ──────────────────────────────────────────────
create table loom.platform_calendar_events (
  id uuid primary key default gen_random_uuid(),
  event_key text not null unique check (length(event_key) between 3 and 200),
  origin text not null check (origin in ('starter', 'official_source', 'platform_manual')),
  source_id text,
  source_name text not null check (length(source_name) between 2 and 200),
  source_url text check (source_url is null or source_url ~ '^https://'),
  source_ref text,
  kind text not null check (kind in ('national', 'religious', 'school_holiday', 'world_day', 'health_awareness', 'local_event', 'commercial')),
  region text not null check (region ~ '^(GLOBAL|SA|SA:[a-z_]{2,30})$'),
  title_ar text check (title_ar is null or length(title_ar) <= 200),
  title_en text check (title_en is null or length(title_en) <= 200),
  untrusted_title text check (untrusted_title is null or length(untrusted_title) <= 300),
  untrusted_description text check (untrusted_description is null or length(untrusted_description) <= 600),
  starts_on date not null,
  ends_on date not null,
  date_basis text not null check (date_basis in ('official_source', 'fixed_gregorian', 'lunar_estimate', 'approximate', 'platform_verified')),
  needs_verification boolean not null,
  verified_by uuid references users(id),
  verified_at timestamptz,
  verification_note text check (verification_note is null or length(verification_note) <= 500),
  topics text[] not null default '{}',
  status text not null default 'active' check (status in ('active', 'withdrawn')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_on >= starts_on),
  check (title_ar is not null or untrusted_title is not null),
  -- An estimate or an approximate date is always "needs verification" until a platform owner verifies it.
  check (date_basis not in ('lunar_estimate', 'approximate') or needs_verification),
  check (date_basis <> 'platform_verified' or (verified_by is not null and not needs_verification))
);
create index platform_calendar_dates_idx on loom.platform_calendar_events (starts_on) where status = 'active';

create table loom.official_source_state (
  source_id text primary key check (source_id ~ '^[a-z0-9_-]{2,40}$'),
  status text not null default 'pending' check (status in ('pending', 'ok', 'error', 'disabled')),
  last_fetched_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  consecutive_failures int not null default 0,
  next_fetch_at timestamptz not null default now(),
  imported_count int not null default 0,
  last_hash text,
  updated_at timestamptz not null default now()
);

-- ── Business calendar choices and timing attachments ────────────────────────
create table loom.calendar_choices (
  business_id uuid not null,
  event_id uuid not null references loom.platform_calendar_events (id),
  choice text not null check (choice in ('adopted', 'hidden')),
  decided_by uuid references users(id),
  decided_at timestamptz not null default now(),
  primary key (business_id, event_id)
);

create table loom.timing_attachments (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  opportunity_id uuid not null,
  ref_kind text not null check (ref_kind in ('platform_event', 'owner_event', 'signal_cluster')),
  ref_id text not null check (length(ref_id) <= 80),
  framing text not null check (framing in ('standard', 'awareness_only')),
  plan_ref text,
  attached_by uuid references users(id),
  created_at timestamptz not null default now(),
  detached_at timestamptz,
  detached_by uuid references users(id),
  foreign key (business_id, opportunity_id) references loom.opportunities (business_id, id)
);
create unique index timing_attachments_live_uq on loom.timing_attachments (business_id, opportunity_id, ref_kind, ref_id) where detached_at is null;
create index timing_attachments_opp_idx on loom.timing_attachments (business_id, opportunity_id);

-- ── Market observations ─────────────────────────────────────────────────────
create table loom.market_observations (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  kind text not null check (kind in ('competitor_offer', 'price_point', 'audience_need', 'channel_norm')),
  offering_id uuid,
  competitor text check (competitor is null or length(competitor) <= 120),
  note text not null check (length(note) between 2 and 1000),
  price_minor bigint check (price_minor is null or price_minor >= 0),
  source_type text not null check (source_type in ('manual', 'link')),
  source_url text check (source_url is null or (source_url ~ '^https://' and length(source_url) <= 500)),
  untrusted_title text check (untrusted_title is null or length(untrusted_title) <= 300),
  untrusted_excerpt text check (untrusted_excerpt is null or length(untrusted_excerpt) <= 600),
  link_status text check (link_status is null or link_status in ('fetched', 'unreachable')),
  observed_on date not null,
  region text check (region is null or length(region) <= 40),
  comparability text not null check (comparability in ('comparable', 'partial', 'not_comparable')),
  comparability_reasons text[] not null default '{}',
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  check (price_minor is null or kind in ('competitor_offer', 'price_point')),
  check (comparability = 'comparable' or cardinality(comparability_reasons) > 0),
  check (source_type = 'manual' or source_url is not null)
);
create index market_observations_idx on loom.market_observations (business_id, archived_at, observed_on desc);

-- ── RLS, grants, append-only ────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['signal_sources', 'signals', 'signal_clusters', 'calendar_choices', 'timing_attachments', 'market_observations']
  loop
    execute format('alter table loom.%I enable row level security', t);
    execute format('create policy business_isolation on loom.%I using (app.tenant_visible(business_id)) with check (app.tenant_visible(business_id))', t);
  end loop;
  foreach t in array array['signal_sources', 'signal_clusters', 'market_observations']
  loop
    execute format('create trigger touch_updated_at before update on loom.%I for each row execute function app.touch_updated_at()', t);
  end loop;
  foreach t in array array['platform_calendar_events', 'official_source_state']
  loop
    execute format('alter table loom.%I enable row level security', t);
    execute format('create policy read_all on loom.%I for select using (true)', t);
    execute format('create policy system_write on loom.%I for all using (app.is_system()) with check (app.is_system())', t);
  end loop;
end $$;
create trigger touch_updated_at before update on loom.platform_calendar_events for each row execute function app.touch_updated_at();

grant select, insert, update, delete on loom.signal_sources, loom.signals, loom.signal_clusters, loom.calendar_choices,
  loom.timing_attachments, loom.market_observations, loom.platform_calendar_events, loom.official_source_state to {{APP_ROLE}};

revoke update, delete on loom.signals from {{APP_ROLE}};
create trigger append_only before update or delete on loom.signals for each row execute function app.forbid_mutation();

-- ── Carry the existing business trend sources over (RSS / user links) ───────
insert into loom.signal_sources (business_id, kind, name, url, access_basis, status, legacy_trend_source_id, created_by, created_at)
select s.tenant_id, s.kind, left(s.name, 120), s.url, case when length(s.access_basis) >= 2 then left(s.access_basis, 300) else 'user-provided' end,
       case when s.status = 'disabled' then 'disabled' else 'active' end, s.id, s.created_by, s.created_at
from trend_sources s
where s.tenant_id is not null and s.kind in ('rss', 'user_link') and s.url ~ '^https://' and length(s.name) >= 2
on conflict do nothing;

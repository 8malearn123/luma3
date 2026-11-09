-- ════════════════════════════════════════════════════════════════════════════
-- 0750 Loom connectors (phase 7), see docs/LOOM_CORE.md §10–§13 and
-- docs/LOOM_MARKETING_ARCHITECTURE.md §5.3, §15, §16, §19.
--
--  * loom.businesses        the Loom-side registry of a business: LUMA tenants
--                           (optional row, holds the chosen sector pack) and
--                           external businesses (no LUMA tenant at all; their id
--                           is the RLS scope id passed to withTenant()).
--  * connections (+cols)    lifecycle (review gate, primary source, secrets
--                           encrypted at rest, cursors, health, record counts).
--  * canonical_records      the staging store of staged connectors (CSV, REST,
--                           inbound webhooks): one row per (connection, entity,
--                           source_id); deletions are tombstones (deleted_at).
--  * import_files           uploaded CSV files (the cursor is the file version).
--  * entity_links           suspected duplicates (never merged automatically).
--  * ingest_events          inbound webhook idempotency (event id per connection).
--  * webhook_endpoints /
--    webhook_deliveries     outgoing webhooks to connected systems + delivery log.
--  * audit_events           Loom's own audit trail for businesses that are not
--                           LUMA tenants (audit_logs.tenant_id references tenants).
--
-- app.apply_conventions() covers schema public only: RLS, grants and
-- append-only guards for the new loom tables are set explicitly below.
-- ════════════════════════════════════════════════════════════════════════════

create table loom.businesses (
  id uuid primary key default gen_random_uuid(),
  host text not null check (host in ('luma', 'external')),
  name text not null check (length(name) between 1 and 160),
  sector_pack text not null default 'beauty' check (sector_pack ~ '^[a-z][a-z0-9_]{1,39}$'),
  timezone text not null default 'Asia/Riyadh' check (length(timezone) between 3 and 64),
  currency text not null default 'SAR' check (currency ~ '^[A-Z]{3}$'),
  city text check (city is null or length(city) <= 80),
  locale text not null default 'ar' check (locale in ('ar', 'en')),
  status text not null default 'active' check (status in ('active', 'suspended')),
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ── Connection lifecycle ────────────────────────────────────────────────────
alter table loom.connections
  add column name text not null default '' check (length(name) <= 120),
  add column review_status text not null default 'not_required'
    check (review_status in ('not_required', 'pending_mapping', 'pending_review', 'approved', 'rejected')),
  add column review jsonb not null default '{}'::jsonb,
  add column reviewed_by uuid references users(id),
  add column reviewed_at timestamptz,
  add column primary_source boolean not null default false,
  add column secret_enc text,
  add column ingest_secret_enc text,
  add column cursors jsonb not null default '{}'::jsonb,
  add column health jsonb not null default '{}'::jsonb,
  add column record_counts jsonb not null default '{}'::jsonb;
create unique index connections_one_primary on loom.connections (business_id) where primary_source;

-- Categories are validated by code (OPPORTUNITY_CATEGORIES) so sector packs can
-- add categories without racing other migrations over one CHECK list.
alter table loom.opportunities drop constraint if exists opportunities_category_check;
alter table loom.opportunities add constraint opportunities_category_format check (category ~ '^[a-z][a-z0-9_]{2,47}$');

-- sync_runs also record connection syncs (no analysis) with their kind and counts.
alter table loom.sync_runs add column kind text not null default 'analysis' check (kind in ('analysis', 'sync', 'ingest'));

-- ── Staging store ───────────────────────────────────────────────────────────
create table loom.canonical_records (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  connection_id uuid not null,
  entity text not null check (entity ~ '^[a-z_]{3,40}$'),
  source_id text not null check (length(source_id) between 1 and 200),
  source_version text not null,
  data jsonb not null,
  deleted_at timestamptz,
  origin text not null default 'sync' check (origin in ('sync', 'csv', 'rest', 'webhook')),
  first_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (connection_id, entity, source_id),
  foreign key (business_id, connection_id) references loom.connections (business_id, id) on delete cascade
);
create index canonical_records_read_idx on loom.canonical_records (business_id, connection_id, entity, source_id);

create table loom.import_files (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  connection_id uuid not null,
  entity text not null check (entity ~ '^[a-z_]{3,40}$'),
  version int not null,
  filename text not null check (length(filename) <= 200),
  sha256 text not null,
  header jsonb not null default '[]'::jsonb,
  row_count int not null default 0,
  status text not null check (status in ('valid', 'invalid', 'applied', 'superseded')),
  errors jsonb not null default '[]'::jsonb,
  content text not null,
  uploaded_by uuid references users(id),
  created_at timestamptz not null default now(),
  applied_at timestamptz,
  unique (connection_id, entity, version),
  foreign key (business_id, connection_id) references loom.connections (business_id, id) on delete cascade
);

create table loom.entity_links (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  connection_id uuid not null,
  entity text not null,
  source_id_a text not null,
  source_id_b text not null,
  reason text not null check (reason in ('same_contact_hash', 'same_name', 'same_external_ref')),
  confidence double precision not null check (confidence > 0 and confidence <= 1),
  status text not null default 'suggested' check (status in ('suggested', 'confirmed', 'rejected')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (source_id_a < source_id_b),
  unique (connection_id, entity, source_id_a, source_id_b),
  foreign key (business_id, connection_id) references loom.connections (business_id, id) on delete cascade
);

create table loom.ingest_events (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  connection_id uuid not null,
  event_id text not null check (length(event_id) between 1 and 200),
  signed_at timestamptz not null,
  records int not null default 0,
  result jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default now(),
  unique (connection_id, event_id),
  foreign key (business_id, connection_id) references loom.connections (business_id, id) on delete cascade
);

-- ── Outgoing webhooks ───────────────────────────────────────────────────────
create table loom.webhook_endpoints (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  url text not null check (url ~ '^https://' and length(url) <= 500),
  events text[] not null check (cardinality(events) between 1 and 10),
  secret_enc text not null,
  active boolean not null default true,
  description text check (description is null or length(description) <= 200),
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, id)
);

create table loom.webhook_deliveries (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  endpoint_id uuid not null,
  event_id text not null,
  event_type text not null check (event_type in ('plan.ready', 'opportunity.created', 'plan.revision_proposed', 'outcome.measured')),
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'delivered', 'failed')),
  attempts int not null default 0,
  last_status int,
  last_error text,
  last_attempt_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  unique (endpoint_id, event_id),
  foreign key (business_id, endpoint_id) references loom.webhook_endpoints (business_id, id) on delete cascade
);
create index webhook_deliveries_idx on loom.webhook_deliveries (business_id, created_at desc);

-- ── Loom audit trail (external businesses) ──────────────────────────────────
create table loom.audit_events (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  actor_user_id uuid references users(id),
  actor_kind text not null,
  action text not null,
  target_type text,
  target_id text,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index loom_audit_events_idx on loom.audit_events (business_id, created_at desc);

-- ── RLS, grants, append-only ────────────────────────────────────────────────
alter table loom.businesses enable row level security;
create policy business_isolation on loom.businesses using (app.tenant_visible(id)) with check (app.tenant_visible(id));
create trigger touch_updated_at before update on loom.businesses for each row execute function app.touch_updated_at();

do $$
declare t text;
begin
  foreach t in array array['canonical_records', 'import_files', 'entity_links', 'ingest_events', 'webhook_endpoints', 'webhook_deliveries', 'audit_events']
  loop
    execute format('alter table loom.%I enable row level security', t);
    execute format('create policy business_isolation on loom.%I using (app.tenant_visible(business_id)) with check (app.tenant_visible(business_id))', t);
  end loop;
  foreach t in array array['canonical_records', 'entity_links', 'webhook_endpoints']
  loop
    execute format('create trigger touch_updated_at before update on loom.%I for each row execute function app.touch_updated_at()', t);
  end loop;
end $$;

grant select, insert, update, delete on loom.businesses, loom.canonical_records, loom.import_files, loom.entity_links,
  loom.ingest_events, loom.webhook_endpoints, loom.webhook_deliveries, loom.audit_events to {{APP_ROLE}};

do $$
declare t text;
begin
  foreach t in array array['ingest_events', 'audit_events']
  loop
    execute format('revoke update, delete on loom.%I from {{APP_ROLE}}', t);
    execute format('create trigger append_only before update or delete on loom.%I for each row execute function app.forbid_mutation()', t);
  end loop;
end $$;

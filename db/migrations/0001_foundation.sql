-- ════════════════════════════════════════════════════════════════════════════
-- 0001 Foundation: extensions, helper functions, row-level-security primitives.
--
-- Tenant isolation model (defence in depth):
--   1. The application derives tenant scope from the authenticated membership and
--      runs every tenant query inside a transaction with
--        SET LOCAL app.tenant_id = '<uuid>'
--   2. Every table carrying tenant_id has ROW LEVEL SECURITY with a policy that
--      only exposes rows of app.tenant_id to the runtime role (which is never the
--      table owner). A bug that forgets a WHERE clause therefore still cannot read
--      or write another tenant's rows. Only reviewed SECURITY DEFINER functions
--      owned by the migration role bypass it, and each returns allowlisted columns.
--   3. Cross-tenant work (platform administration, webhooks, the customer's own
--      cross-salon history, scheduled jobs before they resolve a tenant) uses
--        SET LOCAL app.scope = 'system'
--      only through dedicated, reviewed server functions.
-- ════════════════════════════════════════════════════════════════════════════

create extension if not exists pgcrypto;
create extension if not exists btree_gist;
create extension if not exists citext;

create schema if not exists app;
grant usage on schema app to {{APP_ROLE}};

create or replace function app.current_tenant() returns uuid
language sql stable as $$
  select nullif(current_setting('app.tenant_id', true), '')::uuid
$$;

create or replace function app.is_system() returns boolean
language sql stable as $$
  select coalesce(current_setting('app.scope', true), '') = 'system'
$$;

create or replace function app.tenant_visible(t uuid) returns boolean
language sql stable as $$
  select app.is_system() or (t is not null and t = app.current_tenant())
$$;

-- Generic updated_at maintenance.
create or replace function app.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- Append-only guard for ledgers, audit logs and immutable snapshots. Grants are
-- also revoked, but the trigger protects against owner-level mistakes too.
create or replace function app.forbid_mutation() returns trigger
language plpgsql as $$
begin
  raise exception 'table % is append-only', tg_table_name using errcode = '42501';
end $$;

-- Applies tenant RLS + updated_at triggers + grants to every table in public
-- that has the corresponding column. Idempotent; each migration calls it last.
create or replace function app.apply_conventions(app_role text) returns void
language plpgsql as $$
declare
  r record;
begin
  for r in
    select c.relname as tbl
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped
    where n.nspname = 'public' and c.relkind = 'r'
  loop
    execute format('alter table public.%I enable row level security', r.tbl);
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = r.tbl and policyname = 'tenant_isolation') then
      execute format(
        'create policy tenant_isolation on public.%I using (app.tenant_visible(tenant_id)) with check (app.tenant_visible(tenant_id))',
        r.tbl);
    end if;
  end loop;

  for r in
    select c.relname as tbl
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attname = 'updated_at' and not a.attisdropped
    where n.nspname = 'public' and c.relkind = 'r'
  loop
    if not exists (select 1 from pg_trigger where tgrelid = ('public.' || quote_ident(r.tbl))::regclass and tgname = 'touch_updated_at') then
      execute format('create trigger touch_updated_at before update on public.%I for each row execute function app.touch_updated_at()', r.tbl);
    end if;
  end loop;

  execute format('grant select, insert, update, delete on all tables in schema public to %I', app_role);
  execute format('grant usage, select on all sequences in schema public to %I', app_role);
  execute format('grant execute on all functions in schema app to %I', app_role);
end $$;

-- Marks a table append-only for the runtime role.
create or replace function app.make_append_only(tbl text, app_role text) returns void
language plpgsql as $$
begin
  execute format('revoke update, delete on public.%I from %I', tbl, app_role);
  if not exists (select 1 from pg_trigger where tgrelid = ('public.' || quote_ident(tbl))::regclass and tgname = 'append_only') then
    execute format('create trigger append_only before update or delete on public.%I for each row execute function app.forbid_mutation()', tbl);
  end if;
end $$;

-- 0023 apply_conventions() grants DML on all tables, which silently re-granted
-- UPDATE/DELETE on append-only tables (the trigger still blocked changes) and
-- access to schema_migrations. It now re-applies those revocations after granting.
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

  -- Keep append-only ledgers append-only at the privilege level too.
  for r in
    select c.relname as tbl
    from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and t.tgname = 'append_only'
  loop
    execute format('revoke update, delete on public.%I from %I', r.tbl, app_role);
  end loop;
  if to_regclass('public.schema_migrations') is not null then
    execute format('revoke all on public.schema_migrations from %I', app_role);
  end if;
end $$;

select app.apply_conventions('{{APP_ROLE}}');

-- 0014 Asset lookup for the media route (before tenant scope is known).
-- Returns only what is needed to authorise and stream the file.
create or replace function app.asset_for_serving(p_id uuid)
returns table (id uuid, tenant_id uuid, storage_key text, mime text, visibility text, purpose text, status text)
language sql stable security definer set search_path = public as $$
  select a.id, a.tenant_id, a.storage_key, a.mime, a.visibility, a.purpose, a.status from assets a where a.id = p_id
$$;
grant execute on function app.asset_for_serving(uuid) to {{APP_ROLE}};

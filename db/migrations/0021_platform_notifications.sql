-- 0021 Platform-level notifications (tenant_id NULL) can be raised from inside a
-- business-scoped transaction (e.g. an incident escalation). Under RLS the
-- ON CONFLICT dedupe check cannot see NULL-tenant rows from tenant scope, so the
-- insert goes through a narrow SECURITY DEFINER function that only ever writes
-- NULL-tenant rows for the given users.
create or replace function app.insert_platform_notifications(
  p_users uuid[], p_kind text, p_title_ar text, p_title_en text, p_body_ar text, p_body_en text,
  p_target_path text, p_data jsonb, p_dedupe_key text
) returns void
language sql security definer set search_path = public, pg_temp as $$
  insert into notifications (tenant_id, user_id, kind, title_ar, title_en, body_ar, body_en, target_path, data, dedupe_key)
  select null, u, p_kind, p_title_ar, p_title_en, p_body_ar, p_body_en, p_target_path, coalesce(p_data, '{}'::jsonb), p_dedupe_key
  from unnest(p_users) as u
  on conflict (user_id, dedupe_key) where dedupe_key is not null do nothing;
$$;
revoke all on function app.insert_platform_notifications(uuid[], text, text, text, text, text, text, jsonb, text) from public;
grant execute on function app.insert_platform_notifications(uuid[], text, text, text, text, text, text, jsonb, text) to {{APP_ROLE}};

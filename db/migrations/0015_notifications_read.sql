-- 0015 A user's notifications span tenants; marking read is scoped to the owner.
create or replace function app.mark_notifications_read(p_user uuid, p_ids uuid[])
returns int language sql volatile security definer set search_path = public as $$
  with u as (update notifications set read_at = now() where user_id = p_user and read_at is null and (p_ids is null or id = any(p_ids)) returning 1)
  select count(*)::int from u
$$;
create or replace function app.unread_notifications(p_user uuid)
returns int language sql stable security definer set search_path = public as $$
  select count(*)::int from notifications where user_id = p_user and read_at is null and expires_at > now()
$$;
grant execute on function app.mark_notifications_read(uuid, uuid[]) to {{APP_ROLE}};
grant execute on function app.unread_notifications(uuid) to {{APP_ROLE}};

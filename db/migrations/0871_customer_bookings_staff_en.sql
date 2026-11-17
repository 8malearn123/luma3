-- Customer booking list (app.customer_bookings, 0004):
--  * each item also carries the specialist's current English name
--    (staff_name_en) so the English UI does not show the Arabic snapshot name
--    when an English one exists (LUMA-AUDIT-039). The stored snapshot
--    (booking_items.staff_name) is unchanged and remains the fallback;
--  * superseded items (replaced by a reschedule) are no longer listed next to
--    their replacements.
create or replace function app.customer_bookings(p_user uuid, p_limit int, p_before timestamptz)
returns table (id uuid, tenant_id uuid, tenant_slug text, tenant_name text, number text, status text, payment_status text,
               starts_at timestamptz, ends_at timestamptz, timezone text, total_minor bigint, currency char(3), items jsonb)
language sql stable security definer set search_path = public as $$
  select b.id, b.tenant_id, t.slug::text, t.name, b.number, b.status, b.payment_status, b.starts_at, b.ends_at, b.timezone,
         b.total_minor, b.currency,
         coalesce((select jsonb_agg(jsonb_build_object('service_name_ar', i.service_name_ar, 'service_name_en', i.service_name_en,
                   'staff_name', i.staff_name, 'staff_name_en', sp.display_name_en, 'starts_at', i.starts_at, 'ends_at', i.ends_at) order by i.sequence)
                   from booking_items i left join staff_profiles sp on sp.id = i.staff_id and sp.tenant_id = i.tenant_id
                   where i.booking_id = b.id and i.superseded_at is null), '[]'::jsonb)
  from bookings b join tenants t on t.id = b.tenant_id
  where b.customer_user_id = p_user and b.status not in ('draft')
    and (p_before is null or b.starts_at < p_before)
  order by b.starts_at desc
  limit least(p_limit, 100)
$$;

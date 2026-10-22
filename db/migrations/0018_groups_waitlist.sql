-- 0018 Group sessions reserve staff/resource time through the same exclusion
-- constraints as individual bookings: an allocation belongs to either a booking
-- or a group session.
alter table booking_allocations alter column booking_id drop not null;
alter table booking_allocations add constraint booking_allocations_owner_chk check (booking_id is not null or group_session_id is not null);

alter table group_sessions add column title_ar text;
alter table group_sessions add column title_en text;
alter table group_sessions add column cancelled_reason text;
alter table group_session_bookings add column released_at timestamptz;

-- Waitlist ranking policy (declared): first-come first-served by request time,
-- preferring entries that asked for the freed specialist; one live offer per slot.
alter table tenant_settings add column waitlist_offer_ttl_min int not null default 30 check (waitlist_offer_ttl_min between 5 and 1440);

-- Waitlist offer lookup for the customer who received it.
create or replace function app.waitlist_offer_ref(p_user uuid, p_offer uuid)
returns table (tenant_id uuid, tenant_slug text)
language sql stable security definer set search_path = public as $$
  select o.tenant_id, t.slug::text from waitlist_offers o
  join waitlist_entries e on e.id = o.waitlist_entry_id
  join tenants t on t.id = o.tenant_id
  where o.id = p_offer and e.customer_user_id = p_user
$$;
grant execute on function app.waitlist_offer_ref(uuid, uuid) to {{APP_ROLE}};

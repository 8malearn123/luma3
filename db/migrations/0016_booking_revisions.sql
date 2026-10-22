-- 0016 Rescheduling keeps the same booking (payments stay linked) and replaces
-- its items atomically. Earlier items remain for history, marked superseded.
alter table booking_items add column revision int not null default 1;
alter table booking_items add column superseded_at timestamptz;
alter table booking_items drop constraint booking_items_booking_id_sequence_key;
alter table booking_items add constraint booking_items_revision_sequence_key unique (booking_id, revision, sequence);
alter table bookings add column revision int not null default 1;
create index booking_items_current_idx on booking_items (tenant_id, booking_id) where superseded_at is null;

-- A customer acting on her own booking (cancel/reschedule from /account): resolves
-- the owning tenant only if the booking belongs to this user.
create or replace function app.customer_booking_ref(p_user uuid, p_booking uuid)
returns table (tenant_id uuid, tenant_slug text)
language sql stable security definer set search_path = public as $$
  select b.tenant_id, t.slug::text from bookings b join tenants t on t.id = b.tenant_id
  where b.id = p_booking and b.customer_user_id = p_user
$$;
grant execute on function app.customer_booking_ref(uuid, uuid) to {{APP_ROLE}};

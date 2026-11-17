-- Verification gap (audit §2 / LUMA-AUDIT-046): a chair linked to specialists (D1b) is busy
-- while they are booked. Internal bookings already reserve the linked chair itself (same
-- resource exclusion constraint as a space booking), but group sessions and event bookings
-- reserve only the specialist, so "chair rented to an expert" vs "linked specialist booked
-- for a group/event" was checked in application code only — and only on the hosting side.
-- A parallel test (tests/integration/hosting-conflicts.test.ts) showed both could commit.
--
-- Guarantee: on every active allocation that is either (a) a space booking's chair, or
-- (b) a group-session/event staff reservation (no booking_id, no space), take a transaction
-- advisory lock per affected chair (stable order) and refuse an overlap with the other kind
-- with exclusion_violation (23P01) — mapped to 409 slot_unavailable like the existing
-- constraints. The lock serialises concurrent writers; the check after the lock sees the
-- other transaction's committed row (READ COMMITTED: each statement takes a new snapshot).

create or replace function app.workspace_linked_staff_guard() returns trigger
language plpgsql as $$
declare
  chair uuid;
begin
  if new.state not in ('held', 'confirmed') or (new.state = 'held' and new.expires_at <= now()) then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.state in ('held', 'confirmed') and old.during = new.during and coalesce(old.resource_id, old.staff_id) = coalesce(new.resource_id, new.staff_id) then
    return new;
  end if;

  if new.workspace_booking_id is not null and new.resource_id is not null then
    -- (a) a space booking reserves a chair: no group/event reservation of a linked specialist may overlap.
    perform pg_advisory_xact_lock(hashtextextended('ws-chair:' || new.resource_id::text, 0));
    if exists (
      select 1 from booking_allocations a
      join resource_staff_links l on l.tenant_id = a.tenant_id and l.staff_id = a.staff_id and l.resource_id = new.resource_id
      where a.tenant_id = new.tenant_id and a.id <> new.id
        and a.booking_id is null and a.workspace_booking_id is null and a.within_workspace_booking_id is null
        and (a.state = 'confirmed' or (a.state = 'held' and a.expires_at > now()))
        and a.during && new.during
    ) then
      raise exception 'The chair''s linked specialist is booked at that time'
        using errcode = 'exclusion_violation', constraint = 'booking_allocations_linked_staff_space';
    end if;
  elsif new.staff_id is not null and new.booking_id is null and new.workspace_booking_id is null and new.within_workspace_booking_id is null then
    -- (b) a group session / event booking reserves a specialist: none of her linked chairs may be rented then.
    for chair in select l.resource_id from resource_staff_links l where l.tenant_id = new.tenant_id and l.staff_id = new.staff_id order by l.resource_id loop
      perform pg_advisory_xact_lock(hashtextextended('ws-chair:' || chair::text, 0));
    end loop;
    if exists (
      select 1 from booking_allocations a
      join resource_staff_links l on l.tenant_id = a.tenant_id and l.resource_id = a.resource_id and l.staff_id = new.staff_id
      where a.tenant_id = new.tenant_id and a.id <> new.id and a.workspace_booking_id is not null
        and (a.state = 'confirmed' or (a.state = 'held' and a.expires_at > now()))
        and a.during && new.during
    ) then
      raise exception 'This specialist''s chair is rented to an expert at that time'
        using errcode = 'exclusion_violation', constraint = 'booking_allocations_linked_staff_space';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists booking_allocations_linked_staff_space on booking_allocations;
create trigger booking_allocations_linked_staff_space
  before insert or update of state, during on booking_allocations
  for each row execute function app.workspace_linked_staff_guard();

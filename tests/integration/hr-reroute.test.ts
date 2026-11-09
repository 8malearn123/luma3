import { describe, expect, it } from 'vitest';
import { at, makeSalon } from '../helpers/salon';
import { book, dayOffset, member, userId } from '../helpers/hr';
import { withTenant } from '@/server/db/client';
import * as leave from '@/app/api/v1/t/[tenantSlug]/leave/route';
import * as leaveDecide from '@/app/api/v1/t/[tenantSlug]/leave/[id]/route';
import * as reroutes from '@/app/api/v1/t/[tenantSlug]/hr/leave/[id]/reroutes/route';

describe('rerouting bookings when leave is approved', () => {
  it('suggests a free colleague offering the same service, reassigns in one click, and otherwise reschedules or cancels with notification, keeping a log', async () => {
    const s = await makeSalon();
    const p = { tenantSlug: s.slug };
    const d5 = dayOffset(5), d6 = dayOffset(6);
    // Haircut: Sara or Huda. Colour: Sara only.
    const b1 = await book(s, s.services.haircut, s.staff.sara, d5, '10:00');
    const b2 = await book(s, s.services.color, s.staff.sara, d5, '14:00');
    const b3 = await book(s, s.services.haircut, s.staff.sara, d6, '10:00');
    await book(s, s.services.nails, s.staff.huda, d6, '10:00'); // Huda is busy then.

    const lv = await s.owner.call(leave.POST, { params: p, body: { staff_id: s.staff.sara, starts_at: at(d5, '00:00'), ends_at: at(dayOffset(7), '00:00'), leave_type: 'emergency' } });
    expect(lv.status).toBe(201);
    const leaveId = lv.body.data.id;
    // Not approved yet → nothing to reroute.
    expect((await s.owner.call(reroutes.GET, { params: { ...p, id: leaveId } })).body.error.code).toBe('leave_not_approved');
    const ok = await s.owner.call(leaveDecide.POST, { params: { ...p, id: leaveId }, body: { decision: 'approved' } });
    expect(ok.body.data.affected_booking_ids.sort()).toEqual([b1.id, b2.id, b3.id].sort());
    const ownerNote = await withTenant(s.tenantId, (trx) => trx.selectFrom('notifications').select(['target_path']).where('kind', '=', 'leave.affects_bookings').execute());
    expect(ownerNote[0]!.target_path).toContain(`reroute=${leaveId}`);

    const sara = await member(s, 'specialist', s.staff.sara);
    expect((await sara.call(reroutes.GET, { params: { ...p, id: leaveId } })).status).toBe(403);

    const g = (await s.owner.call(reroutes.GET, { params: { ...p, id: leaveId } })).body.data;
    const of = (id: string) => g.bookings.find((x: any) => x.booking_id === id);
    expect(of(b1.id)).toMatchObject({ suggested_staff_id: s.staff.huda, candidates: [{ staff_id: s.staff.huda, same_price: true }] });
    expect(of(b2.id).candidates).toEqual([]);
    expect(of(b3.id).candidates).toEqual([]);

    // One click: reassign to the suggested colleague.
    expect((await s.owner.call(reroutes.POST, { params: { ...p, id: leaveId }, body: { action: 'reassign', booking_id: b1.id, to_staff_id: s.staff.sara } })).body.error.code).toBe('staff_on_leave');
    expect((await s.owner.call(reroutes.POST, { params: { ...p, id: leaveId }, body: { action: 'reassign', booking_id: b3.id, to_staff_id: s.staff.huda } })).body.error.code).toBe('reroute_slot_unavailable');
    const r1 = await s.owner.call(reroutes.POST, { params: { ...p, id: leaveId }, body: { action: 'reassign', booking_id: b1.id, to_staff_id: s.staff.huda } });
    expect(r1.status).toBe(201);
    const items = await withTenant(s.tenantId, (trx) => trx.selectFrom('booking_items').select(['staff_id', 'starts_at']).where('booking_id', '=', b1.id).where('superseded_at', 'is', null).execute());
    expect(items).toEqual([{ staff_id: s.staff.huda, starts_at: new Date(at(d5, '10:00')) }]);

    // No colleague: move to another day with the same specialist, or cancel and notify the customer.
    const r2 = await s.owner.call(reroutes.POST, { params: { ...p, id: leaveId }, body: { action: 'reschedule', booking_id: b2.id, start: at(dayOffset(9), '14:00') } });
    expect(r2.status).toBe(201);
    const moved = await withTenant(s.tenantId, (trx) => trx.selectFrom('bookings').select(['starts_at', 'status']).where('id', '=', b2.id).executeTakeFirstOrThrow());
    expect(moved).toMatchObject({ status: 'confirmed', starts_at: new Date(at(dayOffset(9), '14:00')) });
    const r3 = await s.owner.call(reroutes.POST, { params: { ...p, id: leaveId }, body: { action: 'cancel', booking_id: b3.id, reason: 'الخبيرة في إجازة' } });
    expect(r3.status).toBe(201);
    const cancelled = await withTenant(s.tenantId, (trx) => trx.selectFrom('bookings').select(['status', 'cancel_reason']).where('id', '=', b3.id).executeTakeFirstOrThrow());
    expect(cancelled).toMatchObject({ status: 'cancelled', cancel_reason: 'الخبيرة في إجازة' });
    const customerNote = await withTenant(s.tenantId, async (trx) => trx.selectFrom('notifications').select('kind').where('user_id', '=', await userId(b3.customer)).execute());
    expect(customerNote.map((n) => n.kind)).toContain('booking.cancelled_staff_leave');
    const outbox = await withTenant(s.tenantId, (trx) => trx.selectFrom('outbox_events').select('topic').where('topic', '=', 'booking.cancelled').execute());
    expect(outbox.length).toBeGreaterThan(0);

    const after = (await s.owner.call(reroutes.GET, { params: { ...p, id: leaveId } })).body.data;
    expect(after.bookings).toEqual([]);
    expect(after.log.map((l: any) => l.action).sort()).toEqual(['cancelled', 'reassigned', 'rescheduled']);
    expect(after.log.find((l: any) => l.action === 'reassigned')).toMatchObject({ booking_id: b1.id, to_staff_id: s.staff.huda, from_staff_id: s.staff.sara });
  });
});

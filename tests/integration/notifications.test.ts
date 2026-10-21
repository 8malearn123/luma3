import { describe, expect, it } from 'vitest';
import { at, customer, futureDate, makeSalon } from '../helpers/salon';
import { withSystem, withTenant } from '@/server/db/client';
import * as hold from '@/app/api/v1/s/[slug]/bookings/route';
import * as checkout from '@/app/api/v1/s/[slug]/bookings/[id]/checkout/route';
import * as notifications from '@/app/api/v1/notifications/route';
import { runOutbox } from '@/server/jobs/runner';

describe('booking notifications', () => {
  it('creates an in-app notification and records simulated deliveries exactly once', async () => {
    const s = await makeSalon();
    await withSystem('test', (trx) => trx.updateTable('tenant_settings').set({ notify_channels: ['in_app', 'email'] }).where('tenant_id', '=', s.tenantId).execute());
    const c = await customer();
    const h = await c.call(hold.POST, { params: { slug: s.slug }, body: { items: [{ key: 'x', service_id: s.services.haircut, staff_id: s.staff.sara, start: at(futureDate(3), '10:00') }] }, idempotencyKey: true });
    await c.call(checkout.POST, { params: { slug: s.slug, id: h.body.data.booking_id }, body: { option: 'on_site' }, idempotencyKey: true });
    const n = await c.call(notifications.GET);
    expect(n.body.data.unread).toBeGreaterThanOrEqual(1);
    expect(n.body.data.items[0].kind).toBe('booking.confirmed');
    await runOutbox(); await runOutbox();
    const deliveries = await withTenant(s.tenantId, (trx) => trx.selectFrom('notification_deliveries').select(['channel', 'status', 'template_key']).where('template_key', '=', 'booking.confirmed').execute());
    expect(deliveries).toEqual([{ channel: 'email', status: 'simulated', template_key: 'booking.confirmed' }]);
  });
});

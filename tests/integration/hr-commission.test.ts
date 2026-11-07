import { describe, expect, it } from 'vitest';
import { makeSalon, type Salon } from '../helpers/salon';
import { book, dayOffset, member, ownerAccess, thisMonth } from '../helpers/hr';
import { withTenant } from '@/server/db/client';
import { transition } from '@/server/domains/booking/service';
import * as onSite from '@/app/api/v1/t/[tenantSlug]/payments/on-site/route';
import * as policy from '@/app/api/v1/t/[tenantSlug]/payroll/commission-policy/route';
import * as overrides from '@/app/api/v1/t/[tenantSlug]/payroll/commission-overrides/route';
import * as override from '@/app/api/v1/t/[tenantSlug]/payroll/commission-overrides/[staffId]/route';
import * as sheet from '@/app/api/v1/t/[tenantSlug]/payroll/sheet/route';
import * as close from '@/app/api/v1/t/[tenantSlug]/payroll/close/route';

async function serve(s: Salon, serviceId: string, staffId: string) {
  const { id } = await book(s, serviceId, staffId, dayOffset(2), '10:00');
  const b = await withTenant(s.tenantId, (trx) => trx.selectFrom('bookings').select(['starts_at', 'total_minor']).where('id', '=', id).executeTakeFirstOrThrow());
  await s.owner.call(onSite.POST, { params: { tenantSlug: s.slug }, body: { booking_id: id, amount_minor: b.total_minor, method: 'cash', reference: 'R-1' }, idempotencyKey: true });
  const access = await ownerAccess(s);
  const actor = { kind: 'staff' as const, access, audit: { userId: null, kind: 'user' as const } };
  const when = new Date(b.starts_at.getTime() + 60_000);
  await transition(s.tenantId, id, 'check_in', actor, { now: when });
  await transition(s.tenantId, id, 'complete', actor, { now: when });
}

describe('per-staff commission override', () => {
  it('replaces the business policy for that staff member only, and the rate is frozen on the payslip', async () => {
    const s = await makeSalon();
    const p = { tenantSlug: s.slug };
    await s.owner.call(policy.PATCH, { method: 'PATCH', params: p, body: { services: { enabled: true, rate_bp: 1000, tiers: [] } } });
    await serve(s, s.services.haircut, s.staff.sara);
    await serve(s, s.services.haircut, s.staff.huda);

    const reception = await member(s, 'receptionist');
    expect((await reception.call(override.PUT, { method: 'PUT', params: { ...p, staffId: s.staff.sara }, body: { services: { enabled: true, rate_bp: 5000, tiers: [] } } })).status).toBe(403);
    const bad = await s.owner.call(override.PUT, { method: 'PUT', params: { ...p, staffId: s.staff.sara }, body: { services: { enabled: true, rate_bp: 2500, tiers: [{ threshold_minor: 5000, rate_bp: 3000 }, { threshold_minor: 1000, rate_bp: 4000 }] } } });
    expect(bad.status).toBe(422);
    const set = await s.owner.call(override.PUT, { method: 'PUT', params: { ...p, staffId: s.staff.sara }, body: { services: { enabled: true, rate_bp: 2500, tiers: [{ threshold_minor: 50000, rate_bp: 4000 }] }, products: { enabled: false, rate_bp: 0, tiers: [] } } });
    expect(set.status).toBe(200);
    expect((await s.owner.call(overrides.GET, { params: p })).body.data).toEqual([expect.objectContaining({ staff_id: s.staff.sara, services: { enabled: true, rate_bp: 2500, tiers: [{ threshold_minor: 50000, rate_bp: 4000 }] } })]);

    const rows = (await s.owner.call(sheet.GET, { params: p, query: { month: thisMonth() } })).body.data.rows;
    const sara = rows.find((r: any) => r.staff_id === s.staff.sara);
    const huda = rows.find((r: any) => r.staff_id === s.staff.huda);
    expect(sara).toMatchObject({ service_rate_bp: 2500, service_commission_minor: 2500, commission_override: { services: true, products: true } });
    expect(huda).toMatchObject({ service_rate_bp: 1000, service_commission_minor: 1000, commission_override: { services: false, products: false } });

    // Removing the products override keeps the services one.
    const rm = await s.owner.call(override.PUT, { method: 'PUT', params: { ...p, staffId: s.staff.sara }, body: { products: null } });
    expect(rm.body.data).toMatchObject({ services: { rate_bp: 2500 }, products: null });

    expect((await s.owner.call(close.POST, { params: p, body: { month: thisMonth() } })).status).toBe(201);
    // Changing the override after the close does not change the payslip.
    await s.owner.call(override.PUT, { method: 'PUT', params: { ...p, staffId: s.staff.sara }, body: { services: null } });
    const slip = (await s.owner.call(sheet.GET, { params: p, query: { month: thisMonth() } })).body.data.rows.find((r: any) => r.staff_id === s.staff.sara);
    expect(slip).toMatchObject({ service_rate_bp: 2500, service_commission_minor: 2500 });
    expect((await s.owner.call(overrides.GET, { params: p })).body.data).toEqual([]);
  });
});

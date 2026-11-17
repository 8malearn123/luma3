import { describe, expect, it } from 'vitest';
import { createBusinessFor, signup } from '../helpers/factory';
import { withTenant } from '@/server/db/client';
import * as staff from '@/app/api/v1/t/[tenantSlug]/staff/route';
import * as schedule from '@/app/api/v1/t/[tenantSlug]/staff/[id]/schedule/route';
import * as onboarding from '@/app/api/v1/t/[tenantSlug]/onboarding/route';

/**
 * LUMA-AUDIT-049: storefront opening hours (branch_hours) and specialist
 * schedules (working_hours) are separate by design; the owner is warned when
 * the store would say "Closed" on a day a specialist works.
 */
describe('opening hours vs specialist schedules', () => {
  it('flags days the store shows Closed while a specialist has hours', async () => {
    const owner = await signup('Owner');
    const biz = await createBusinessFor(owner, { plan_code: 'sanaa' });
    const p = { tenantSlug: biz.slug };
    const st = await owner.call(staff.POST, { params: p, body: { display_name: 'سارة' } });
    expect(st.status).toBe(201);
    // Specialist works Sunday (0) and Friday (5).
    const sched = await owner.call(schedule.PUT, { method: 'PUT', params: { ...p, id: st.body.data.id }, body: { branch_id: biz.branchId, ranges: [{ weekday: 0, start_time: '10:00', end_time: '18:00' }, { weekday: 5, start_time: '10:00', end_time: '18:00' }] } });
    expect(sched.status).toBe(200);

    // No opening hours yet: the storefront shows no hours table, nothing to warn about.
    let r = await owner.call(onboarding.GET, { params: p });
    expect(r.body.data.hours_check).toEqual([]);

    // Opening hours say open Sunday only → Friday would show "Closed" although bookable.
    await withTenant(biz.tenantId, (trx) => trx.insertInto('branch_hours').values({ tenant_id: biz.tenantId, branch_id: biz.branchId, weekday: 0, opens: '09:00', closes: '22:00' }).execute());
    r = await owner.call(onboarding.GET, { params: p });
    expect(r.body.data.hours_check).toEqual([expect.objectContaining({ branch_id: biz.branchId, closed_but_staffed: [5] })]);

    // Adding Friday to the opening hours clears it.
    await withTenant(biz.tenantId, (trx) => trx.insertInto('branch_hours').values({ tenant_id: biz.tenantId, branch_id: biz.branchId, weekday: 5, opens: '09:00', closes: '22:00' }).execute());
    r = await owner.call(onboarding.GET, { params: p });
    expect(r.body.data.hours_check).toEqual([]);
  });
});

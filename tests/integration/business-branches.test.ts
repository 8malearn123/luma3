import { describe, expect, it } from 'vitest';
import { createBusinessFor, signup } from '../helpers/factory';
import { addMember } from '../helpers/commerce';
import { booking, customer, service, staffWithHours, todayAt, userIdOf } from '../helpers/business';
import { resolveBranchScope } from '@/server/domains/business/branch-scope';
import * as branches from '@/app/api/v1/t/[tenantSlug]/branches/route';
import * as bookings from '@/app/api/v1/t/[tenantSlug]/bookings/route';
import * as staff from '@/app/api/v1/t/[tenantSlug]/staff/route';
import * as items from '@/app/api/v1/t/[tenantSlug]/inventory/items/route';
import * as overview from '@/app/api/v1/t/[tenantSlug]/overview/route';
import * as scopeRoute from '@/app/api/v1/t/[tenantSlug]/branch-scope/route';
import * as report from '@/app/api/v1/t/[tenantSlug]/finance/report/route';
import * as occupancy from '@/app/api/v1/t/[tenantSlug]/analytics/occupancy/route';

async function twoBranches() {
  const owner = await signup('Owner');
  const biz = await createBusinessFor(owner, { plan_code: 'fareed' });
  const p = { tenantSlug: biz.slug };
  const b2r = await owner.call(branches.POST, { params: p, body: { name: 'فرع جدة', city: 'جدة', timezone: 'Asia/Riyadh' } });
  expect(b2r.status).toBe(201);
  const b1 = biz.branchId, b2 = b2r.body.data.id as string;
  const recep = await addMember(owner, biz.slug, 'receptionist');
  const s1 = await staffWithHours(biz, 'Riyadh staff', b1, { userId: await userIdOf(recep) });
  const s2 = await staffWithHours(biz, 'Jeddah staff', b2);
  const svc = await service(biz);
  const cus = await customer(biz);
  const k1 = await booking(biz, { customerId: cus, serviceId: svc, staffId: s1, startsAt: todayAt('00:30'), branchId: b1 });
  const k2 = await booking(biz, { customerId: cus, serviceId: svc, staffId: s2, startsAt: todayAt('01:30'), branchId: b2, price: 40000 });
  return { owner, recep, biz, p, b1, b2, s1, s2, k1, k2 };
}
const ids = (r: { body: { data: Array<{ id: string }> } }) => r.body.data.map((x) => x.id).sort();

describe('branch switcher', () => {
  it('filters bookings, staff, inventory, finance, analytics and overview by ?branch_id or the per-user cookie', async () => {
    const t = await twoBranches();
    const all = await t.owner.call(bookings.GET, { params: t.p });
    expect(ids(all)).toEqual([t.k1, t.k2].sort());
    expect(ids(await t.owner.call(bookings.GET, { params: t.p, query: { branch_id: t.b2 } }))).toEqual([t.k2]);

    // The header switcher stores the choice in a cookie that every read API honours.
    t.owner.cookies.set(`luma_branch_${t.biz.slug}`, t.b2);
    expect(ids(await t.owner.call(bookings.GET, { params: t.p }))).toEqual([t.k2]);
    expect(ids(await t.owner.call(bookings.GET, { params: t.p, query: { branch_id: 'all' } }))).toEqual([t.k1, t.k2].sort());
    const st = await t.owner.call(staff.GET, { params: t.p });
    expect(st.body.data.map((s: any) => s.id)).toEqual([t.s2]);
    const ov = (await t.owner.call(overview.GET, { params: t.p })).body.data;
    expect(ov.kpis.bookings_today).toBe(1);
    expect(ov.kpis.expected_revenue_today_minor).toBe(40000);
    expect(ov.branch).toEqual({ selected: t.b2, restricted: false });
    const scope = (await t.owner.call(scopeRoute.GET, { params: t.p })).body.data;
    expect(scope.selected).toBe(t.b2);
    expect(scope.branches.map((b: any) => b.id).sort()).toEqual([t.b1, t.b2].sort());
    const occ = (await t.owner.call(occupancy.GET, { params: t.p })).body.data;
    expect(occ.staff.map((s: any) => s.staff_id)).toEqual([t.s2]);
    const d = new Date().toISOString().slice(0, 10);
    const fin = (await t.owner.call(report.GET, { params: t.p, query: { from: d, to: d } }));
    expect(fin.status).toBe(200);
    expect(fin.body.data.branch).toMatchObject({ branch_ids: [t.b2], bookings: expect.any(Number), ledger_scope: 'business' });

    // Inventory items carry a branch.
    await t.owner.call(items.POST, { params: t.p, body: { name: 'Jeddah dye', unit: 'ml', branch_id: t.b2 } });
    t.owner.cookies.set(`luma_branch_${t.biz.slug}`, t.b1);
    await t.owner.call(items.POST, { params: t.p, body: { name: 'Riyadh dye', unit: 'ml', branch_id: t.b1 } });
    const inv = await t.owner.call(items.GET, { params: t.p });
    expect(inv.body.data.items.map((i: any) => i.name)).toEqual(['Riyadh dye']);
    t.owner.cookies.set(`luma_branch_${t.biz.slug}`, 'all');
    expect((await t.owner.call(items.GET, { params: t.p })).body.data.items).toHaveLength(2);
    // A stale/garbage cookie means "all".
    t.owner.cookies.set(`luma_branch_${t.biz.slug}`, 'not-a-branch');
    expect(ids(await t.owner.call(bookings.GET, { params: t.p }))).toHaveLength(2);
  });

  it('staff assigned to a branch only see their branch (explicit other branch = 403, cookie ignored)', async () => {
    const t = await twoBranches();
    expect(ids(await t.recep.call(bookings.GET, { params: t.p }))).toEqual([t.k1]);
    const denied = await t.recep.call(bookings.GET, { params: t.p, query: { branch_id: t.b2 } });
    expect(denied.status).toBe(403);
    t.recep.cookies.set(`luma_branch_${t.biz.slug}`, t.b2);
    expect(ids(await t.recep.call(bookings.GET, { params: t.p }))).toEqual([t.k1]);
    const scope = (await t.recep.call(scopeRoute.GET, { params: t.p })).body.data;
    expect(scope).toMatchObject({ restricted: true, selected: null });
    expect(scope.branches.map((b: any) => b.id)).toEqual([t.b1]);
    const ov = (await t.recep.call(overview.GET, { params: t.p })).body.data;
    expect(ov.kpis.bookings_today).toBe(1);
    expect(ov.branch.restricted).toBe(true);
    const st = await t.recep.call(staff.GET, { params: t.p });
    expect(st.body.data.map((s: any) => s.id)).toEqual([t.s1]);
  });

  it('the owner is never restricted, even with a staff profile in one branch', async () => {
    const t = await twoBranches();
    const access = { tenantId: t.biz.tenantId, role: 'owner', staffProfileId: t.s1 } as never;
    expect(await resolveBranchScope(access, {})).toMatchObject({ branchIds: null, restricted: false });
  });
});

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createBusinessFor, signup } from '../helpers/factory';
import { resolveTenantAccess } from '@/server/tenancy/access';
import { withSystem } from '@/server/db/client';
import { restrictForWorkspace, SOLO_HIDDEN_CAPABILITIES } from '@/server/tenancy/workspace-mode';
import * as staff from '@/app/api/v1/t/[tenantSlug]/staff/route';
import * as staffOne from '@/app/api/v1/t/[tenantSlug]/staff/[id]/route';
import * as schedule from '@/app/api/v1/t/[tenantSlug]/staff/[id]/schedule/route';
import * as payrollSheet from '@/app/api/v1/t/[tenantSlug]/payroll/sheet/route';
import * as leave from '@/app/api/v1/t/[tenantSlug]/leave/route';
import * as hrRequests from '@/app/api/v1/t/[tenantSlug]/hr/requests/route';
import * as attendance from '@/app/api/v1/t/[tenantSlug]/attendance/route';
import * as staffFiles from '@/app/api/v1/t/[tenantSlug]/hr/staff-files/route';
import * as hostingListings from '@/app/api/v1/t/[tenantSlug]/hosting/listings/route';
import * as branches from '@/app/api/v1/t/[tenantSlug]/branches/route';
import * as groupSessions from '@/app/api/v1/t/[tenantSlug]/group-sessions/route';

/**
 * LUMA-AUDIT-014 / owner decision R5: the freelancer workspace is enforced on
 * the server, not only by hiding navigation.
 */
const month = new Date().toISOString().slice(0, 7);

async function expert() {
  const owner = await signup('Solo expert');
  const biz = await createBusinessFor(owner, { business_type: 'expert', plan_code: 'wahaj' });
  return { owner, biz, p: { tenantSlug: biz.slug } };
}

describe('freelancer (expert) workspace rules', () => {
  it('a solo expert has no payroll / attendance / leave / staff files / HR requests / hosting capabilities', async () => {
    const { owner, biz, p } = await expert();
    const u = await withSystem('test: user id', (trx) => trx.selectFrom('users').select('id').where('email', '=', owner.identifier).executeTakeFirstOrThrow());
    const access = await resolveTenantAccess({ userId: u.id, platformRoles: [] } as never, biz.slug);
    expect(access.workspace).toEqual({ solo: true });
    for (const c of [...SOLO_HIDDEN_CAPABILITIES, 'hosting.view', 'hosting.manage']) expect(access.capabilities.has(c as never)).toBe(false);
    expect(access.capabilities.has('schedule.manage')).toBe(true);
    expect(access.capabilities.has('staff.edit')).toBe(true); // «مساعداتي» stays available
    expect((await owner.call(payrollSheet.GET, { params: p, query: { month } })).status).toBe(403);
    expect((await owner.call(leave.GET, { params: p })).status).toBe(403);
    expect((await owner.call(hrRequests.GET, { params: p })).status).toBe(403);
    expect((await owner.call(attendance.GET, { params: p })).status).toBe(403);
    expect((await owner.call(staffFiles.GET, { params: p })).status).toBe(403);
    expect((await owner.call(hostingListings.GET, { params: p })).status).toBe(403);
    const br = await owner.call(branches.POST, { params: p, body: { name: 'فرع ثانٍ' } });
    expect(br.status).toBe(403);
    expect(br.body.error.code).toBe('not_available');
    const gs = await owner.call(groupSessions.POST, { params: p, body: { branch_id: biz.branchId, service_id: randomUUID(), staff_id: biz.staffProfileId, starts_at: new Date(Date.now() + 86_400_000).toISOString(), capacity: 4 } });
    expect(gs.status).toBe(403);
  });

  it('she manages her own schedule (owner edits her own weekly hours)', async () => {
    const { owner, biz, p } = await expert();
    const put = await owner.call(schedule.PUT, { method: 'PUT', params: { ...p, id: biz.staffProfileId! }, body: { branch_id: biz.branchId, ranges: [{ weekday: 6, start_time: '12:00', end_time: '20:00' }] } });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    const got = await owner.call(schedule.GET, { params: { ...p, id: biz.staffProfileId! } });
    expect(got.body.data.hours.map((h: { weekday: number; end_time: string }) => [h.weekday, h.end_time.slice(0, 5)])).toEqual([[6, '20:00']]);
  });

  it('the team areas appear once she has another active staff member, and hide again when the assistant is deactivated', async () => {
    const { owner, p } = await expert();
    expect((await owner.call(payrollSheet.GET, { params: p, query: { month } })).status).toBe(403);
    const a = await owner.call(staff.POST, { params: p, body: { display_name: 'مساعدة' } });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect((await owner.call(payrollSheet.GET, { params: p, query: { month } })).status).toBe(200);
    expect((await owner.call(leave.GET, { params: p })).status).toBe(200);
    expect((await owner.call(hrRequests.GET, { params: p })).status).toBe(200);
    // Still never hosting for an expert.
    expect((await owner.call(hostingListings.GET, { params: p })).status).toBe(403);
    // Data is kept; the areas just hide again while she works alone.
    const off = await owner.call(staffOne.PATCH, { method: 'PATCH', params: { ...p, id: a.body.data.id }, body: { is_active: false } });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    expect((await owner.call(payrollSheet.GET, { params: p, query: { month } })).status).toBe(403);
  });

  it('salons are unaffected', async () => {
    const owner = await signup('Salon owner');
    const biz = await createBusinessFor(owner, { plan_code: 'wahaj' });
    const p = { tenantSlug: biz.slug };
    expect((await owner.call(payrollSheet.GET, { params: p, query: { month } })).status).toBe(200);
    expect((await owner.call(hostingListings.GET, { params: p })).status).toBe(200);
    expect((await owner.call(leave.GET, { params: p })).status).toBe(200);
  });

  it('restrictForWorkspace is a pure filter for experts only', () => {
    const caps = new Set(['payroll.view', 'hosting.view', 'schedule.manage'] as never[]);
    expect(restrictForWorkspace(caps, 'salon', { solo: true })).toBe(caps);
    expect([...restrictForWorkspace(caps, 'expert', { solo: false })]).toEqual(['payroll.view', 'schedule.manage']);
    expect([...restrictForWorkspace(caps, 'expert', { solo: true })]).toEqual(['schedule.manage']);
  });
});

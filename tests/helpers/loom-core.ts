import { randomUUID } from 'node:crypto';
import { withSystem, withTenant } from '@/server/db/client';
import { createBusinessFor, signup } from './factory';
import { addBooking, addConsent, addCustomer, addReview, addService, addStaff } from './marketing-data';

/**
 * A LUMA business arranged for Loom acceptance tests (direct SQL fixtures,
 * like the other analytics tests): 200 days old, staff A working 10:00–18:00
 * daily and qualified for S1 and S2, S1 popular (25 completed visits), S2
 * well rated but less booked (5 visits, five 5-star reviews).
 */
type Biz = { tenantId: string; branchId: string; slug: string };
const DAY = 86_400_000;

export async function hours(biz: Biz, staffId: string, from = '10:00', to = '18:00') {
  await withTenant(biz.tenantId, async (trx) => {
    await trx.insertInto('staff_branch_assignments').values({ tenant_id: biz.tenantId, staff_id: staffId, branch_id: biz.branchId }).onConflict((oc) => oc.doNothing()).execute();
    await trx.insertInto('working_hours').values(Array.from({ length: 7 }, (_, wd) => ({ tenant_id: biz.tenantId, staff_id: staffId, branch_id: biz.branchId, weekday: wd, start_time: from, end_time: to }))).execute();
  });
}

export async function qualify(biz: Biz, staffId: string, serviceId: string) {
  await withTenant(biz.tenantId, (trx) => trx.insertInto('service_staff').values({ tenant_id: biz.tenantId, service_id: serviceId, staff_id: staffId }).execute());
}

export async function loomSalon(opts: { s2Cost?: number | null; s2Staff?: 'A' | 'B'; ageDays?: number; consents?: boolean; name?: string } = {}) {
  const owner = await signup(opts.name ?? 'Loom Owner');
  const created = await createBusinessFor(owner, { plan_code: 'wahaj' });
  const biz: Biz = { tenantId: created.tenantId, branchId: created.branchId, slug: created.slug };
  await withSystem('test: age the business', (trx) => trx.updateTable('tenants').set({ created_at: new Date(Date.now() - (opts.ageDays ?? 200) * DAY) }).where('id', '=', biz.tenantId).execute());
  const A = await addStaff(biz, 'Specialist A');
  await hours(biz, A);
  const s1 = await addService(biz, { name: 'Hair Colour', price: 20000, cost: 4000, duration: 60 });
  const s2 = await addService(biz, { name: 'Glow Facial', price: 30000, cost: opts.s2Cost === undefined ? 6000 : opts.s2Cost, duration: 60 });
  await qualify(biz, A, s1);
  let B: string | null = null;
  if (opts.s2Staff === 'B') { B = await addStaff(biz, 'Specialist B'); await hours(biz, B); await qualify(biz, B, s2); } else await qualify(biz, A, s2);
  const customers: string[] = [];
  for (let i = 0; i < 8; i++) {
    const c = await addCustomer(biz, { name: `Private Name ${i}`, phone: `+96655${String(1000000 + i).slice(-7)}`, email: `secret${i}-${randomUUID().slice(0, 6)}@example.test` });
    if (opts.consents) await addConsent(biz, c, 'push', true);
    customers.push(c);
  }
  // S1: 25 visits over the last 80 days, 11:00 local (inside A's hours).
  for (let i = 0; i < 25; i++) await addBooking(biz, { customerId: customers[i % 8]!, serviceId: s1, staffId: A, startsAt: new Date(Date.now() - (3 + i * 3) * DAY), price: 20000 });
  // S2: 5 visits, each reviewed 5★.
  for (let i = 0; i < 5; i++) {
    const b = await addBooking(biz, { customerId: customers[i]!, serviceId: s2, staffId: B ?? A, startsAt: new Date(Date.now() - (10 + i * 7) * DAY), price: 30000 });
    await addReview(biz, b, customers[i]!, 5, B ?? A);
  }
  return { owner, biz, p: { tenantSlug: biz.slug }, A, B, s1, s2, customers };
}

export async function materialRecipe(biz: Biz, serviceId: string, o: { onHand: number; perService: number; unitCost?: number; approved?: boolean }) {
  return withTenant(biz.tenantId, async (trx) => {
    const it = await trx.insertInto('inventory_items').values({ tenant_id: biz.tenantId, branch_id: biz.branchId, name: 'Facial serum', kind: 'material', unit: 'ml', on_hand: o.onHand, cost_per_unit_minor: o.unitCost ?? 50 })
      .returning('id').executeTakeFirstOrThrow();
    await trx.insertInto('service_material_recipes').values({ tenant_id: biz.tenantId, service_id: serviceId, inventory_item_id: it.id, quantity: o.perService, unit: 'ml', approved_at: o.approved === false ? null : new Date() }).execute();
    return it.id;
  });
}

/** Approved leave for a staff member over the next `days` days (a capacity constraint). */
export async function approvedLeave(biz: Biz, staffId: string, days = 15) {
  return withTenant(biz.tenantId, async (trx) => (await trx.insertInto('leave_requests').values({
    tenant_id: biz.tenantId, staff_id: staffId, during: `[${new Date(Date.now() - DAY).toISOString()},${new Date(Date.now() + days * DAY).toISOString()})`, status: 'approved',
  }).returning('id').executeTakeFirstOrThrow()).id);
}

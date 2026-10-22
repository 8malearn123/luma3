import { sql } from 'kysely';
import type { z } from 'zod';
import { withTenant, type Tx } from '../../db/client';
import { Errors } from '../../http/errors';
import { audit, type AuditActor } from '../../infra/audit';
import { hasCapability, requireWithinLimit, type TenantAccess } from '../../tenancy/access';
import { assertTenantAssets } from '../assets/service';
import type {
  addonInput, categoryInput, categoryPatch, packageInput, priceProposalInput, serviceInput, servicePatch, variantInput,
} from '@/shared/schemas/catalog';

// ── Categories ──────────────────────────────────────────────────────────────
function slugify(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
}

export async function listCategories(access: TenantAccess, kind?: 'service' | 'product', includeArchived = false) {
  return withTenant(access.tenantId, (trx) => {
    let q = trx.selectFrom('categories').selectAll().where('tenant_id', '=', access.tenantId);
    if (kind) q = q.where('kind', '=', kind);
    if (!includeArchived) q = q.where('archived_at', 'is', null);
    return q.orderBy('sort').orderBy('created_at').execute();
  });
}

export async function createCategory(access: TenantAccess, actor: AuditActor, input: z.infer<typeof categoryInput>) {
  return withTenant(access.tenantId, async (trx) => {
    const base = input.slug ?? (slugify(input.name_en ?? '') || `c-${Date.now().toString(36)}`);
    const max = await trx.selectFrom('categories').select(sql<number>`coalesce(max(sort), -1)::int`.as('m')).where('tenant_id', '=', access.tenantId).where('kind', '=', input.kind).executeTakeFirstOrThrow();
    const row = await trx.insertInto('categories').values({
      tenant_id: access.tenantId, kind: input.kind, name_ar: input.name_ar ?? null, name_en: input.name_en ?? null,
      slug: base, is_visible: input.is_visible ?? true, sort: max.m + 1,
    }).returningAll().executeTakeFirstOrThrow();
    await audit(trx, actor, 'category.created', { tenantId: access.tenantId, targetType: 'category', targetId: row.id });
    return row;
  });
}

/** Hiding/archiving never deletes the category, its items, or booking history. */
export async function updateCategory(access: TenantAccess, actor: AuditActor, id: string, patch: z.infer<typeof categoryPatch>) {
  return withTenant(access.tenantId, async (trx) => {
    const row = await trx.updateTable('categories').set({
      ...(patch.name_ar !== undefined ? { name_ar: patch.name_ar } : {}),
      ...(patch.name_en !== undefined ? { name_en: patch.name_en } : {}),
      ...(patch.is_visible !== undefined ? { is_visible: patch.is_visible } : {}),
      ...(patch.archived !== undefined ? { archived_at: patch.archived ? new Date() : null } : {}),
    }).where('id', '=', id).returningAll().executeTakeFirst();
    if (!row) throw Errors.notFound('category');
    await audit(trx, actor, 'category.updated', { tenantId: access.tenantId, targetType: 'category', targetId: id, data: patch });
    return row;
  });
}

export async function reorder(access: TenantAccess, table: 'categories' | 'services' | 'products' | 'staff_profiles', ids: string[]) {
  return withTenant(access.tenantId, async (trx) => {
    const found = await trx.selectFrom(table).select('id').where('id', 'in', ids).execute();
    if (found.length !== new Set(ids).size) throw Errors.notFound();
    for (const [i, id] of ids.entries()) await trx.updateTable(table).set({ sort: i }).where('id', '=', id).execute();
    return { reordered: ids.length };
  });
}

// ── Services ────────────────────────────────────────────────────────────────
type ServiceRow = Awaited<ReturnType<typeof loadServices>>[number];

async function loadServices(trx: Tx, tenantId: string, opts: { ids?: string[]; includeArchived?: boolean } = {}) {
  let q = trx.selectFrom('services').selectAll().where('tenant_id', '=', tenantId);
  if (opts.ids) q = q.where('id', 'in', opts.ids.length ? opts.ids : ['00000000-0000-0000-0000-000000000000']);
  if (!opts.includeArchived) q = q.where('archived_at', 'is', null);
  return q.orderBy('sort').orderBy('created_at').execute();
}

function serializeService(access: TenantAccess, s: ServiceRow, extra: { staff: unknown[]; variants: unknown[]; addons: unknown[]; resources: unknown[] }) {
  const showCost = hasCapability(access, 'costs.view');
  const { cost_minor, ...rest } = s;
  return { ...rest, ...(showCost ? { cost_minor } : {}), ...extra };
}

export async function listServices(access: TenantAccess, opts: { includeArchived?: boolean; categoryId?: string; q?: string } = {}) {
  return withTenant(access.tenantId, async (trx) => {
    let rows = await loadServices(trx, access.tenantId, { includeArchived: opts.includeArchived });
    if (opts.categoryId) rows = rows.filter((r) => r.category_id === opts.categoryId);
    if (opts.q) {
      const q = opts.q.toLowerCase();
      rows = rows.filter((r) => (r.name_ar ?? '').toLowerCase().includes(q) || (r.name_en ?? '').toLowerCase().includes(q));
    }
    return attachServiceRelations(trx, access, rows);
  });
}

async function attachServiceRelations(trx: Tx, access: TenantAccess, rows: ServiceRow[]) {
  const ids = rows.map((r) => r.id);
  if (!ids.length) return [];
  const [staff, variants, addons, resources] = await Promise.all([
    trx.selectFrom('service_staff as ss').innerJoin('staff_profiles as sp', 'sp.id', 'ss.staff_id')
      .select(['ss.service_id', 'ss.staff_id', 'ss.price_override_minor', 'ss.duration_override_min', 'sp.display_name', 'sp.is_active'])
      .where('ss.service_id', 'in', ids).execute(),
    trx.selectFrom('service_variants').selectAll().where('service_id', 'in', ids).orderBy('sort').execute(),
    trx.selectFrom('service_addons').selectAll().where('service_id', 'in', ids).orderBy('sort').execute(),
    trx.selectFrom('service_resource_requirements').selectAll().where('service_id', 'in', ids).execute(),
  ]);
  return rows.map((s) => serializeService(access, s, {
    staff: staff.filter((x) => x.service_id === s.id),
    variants: variants.filter((x) => x.service_id === s.id),
    addons: addons.filter((x) => x.service_id === s.id),
    resources: resources.filter((x) => x.service_id === s.id),
  }));
}

export async function getService(access: TenantAccess, id: string) {
  return withTenant(access.tenantId, async (trx) => {
    const rows = await loadServices(trx, access.tenantId, { ids: [id], includeArchived: true });
    if (!rows.length) throw Errors.notFound('service');
    return (await attachServiceRelations(trx, access, rows))[0]!;
  });
}

async function setServiceStaff(trx: Tx, tenantId: string, serviceId: string, staff: NonNullable<z.infer<typeof serviceInput>['staff']>) {
  await trx.deleteFrom('service_staff').where('service_id', '=', serviceId).execute();
  if (staff.length) {
    // Composite FK (tenant_id, staff_id) rejects another tenant's staff ids.
    await trx.insertInto('service_staff').values(staff.map((s) => ({
      tenant_id: tenantId, service_id: serviceId, staff_id: s.staff_id,
      price_override_minor: s.price_override_minor ?? null, duration_override_min: s.duration_override_min ?? null,
    }))).execute();
  }
}

async function setResourceRequirements(trx: Tx, access: TenantAccess, serviceId: string, reqs: NonNullable<z.infer<typeof serviceInput>['resource_requirements']>) {
  if (reqs.length && !access.plan.features.get('feature.resources')?.enabled) throw Errors.planFeature('feature.resources');
  await trx.deleteFrom('service_resource_requirements').where('service_id', '=', serviceId).execute();
  if (reqs.length) {
    await trx.insertInto('service_resource_requirements').values(reqs.map((r) => ({ tenant_id: access.tenantId, service_id: serviceId, resource_type_id: r.resource_type_id, quantity: r.quantity }))).execute();
  }
}

export async function createService(access: TenantAccess, actor: AuditActor, input: z.infer<typeof serviceInput>) {
  if (input.cost_minor != null && !hasCapability(access, 'costs.view')) throw Errors.forbidden('You cannot set confidential costs');
  return withTenant(access.tenantId, async (trx) => {
    const count = await trx.selectFrom('services').select(sql<number>`count(*)::int`.as('n')).where('tenant_id', '=', access.tenantId).where('archived_at', 'is', null).executeTakeFirstOrThrow();
    requireWithinLimit(access, 'limit.services', count.n);
    if (input.image_asset_id) await assertTenantAssets(trx, access.tenantId, [input.image_asset_id]);
    const max = await trx.selectFrom('services').select(sql<number>`coalesce(max(sort), -1)::int`.as('m')).where('tenant_id', '=', access.tenantId).executeTakeFirstOrThrow();
    const { staff, resource_requirements, ...fields } = input;
    const row = await trx.insertInto('services').values({
      tenant_id: access.tenantId, ...fields, category_id: fields.category_id ?? null, branch_id: fields.branch_id ?? null,
      image_asset_id: fields.image_asset_id ?? null, cost_minor: fields.cost_minor ?? null, sort: max.m + 1,
    }).returning('id').executeTakeFirstOrThrow();
    if (staff) await setServiceStaff(trx, access.tenantId, row.id, staff);
    if (resource_requirements) await setResourceRequirements(trx, access, row.id, resource_requirements);
    await audit(trx, actor, 'service.created', { tenantId: access.tenantId, targetType: 'service', targetId: row.id, data: { price_minor: input.price_minor } });
    return row;
  }).then((r) => getService(access, r.id));
}

/** Whether a price change can be applied directly or must become a proposal. */
function canApprovePrices(access: TenantAccess) {
  return access.role === 'owner';
}

export async function updateService(access: TenantAccess, actor: AuditActor, id: string, patch: z.infer<typeof servicePatch>) {
  if (patch.cost_minor !== undefined && !hasCapability(access, 'costs.view')) throw Errors.forbidden('You cannot set confidential costs');
  const result = await withTenant(access.tenantId, async (trx) => {
    const cur = await trx.selectFrom('services').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
    if (!cur) throw Errors.notFound('service');
    if (cur.version !== patch.version) throw Errors.versionConflict(cur.version);
    const { version: _v, staff, resource_requirements, price_minor, ...fields } = patch;
    let proposalId: string | null = null;
    let newPrice = cur.price_minor;
    if (price_minor !== undefined && price_minor !== cur.price_minor) {
      if (canApprovePrices(access)) {
        newPrice = price_minor;
        await trx.insertInto('service_price_proposals').values({
          tenant_id: access.tenantId, service_id: id, current_price_minor: cur.price_minor, proposed_price_minor: price_minor,
          status: 'approved', proposed_by: actor.userId, decided_by: actor.userId, decided_at: new Date(), reason: 'direct owner change',
        }).execute();
      } else {
        const p = await trx.insertInto('service_price_proposals').values({
          tenant_id: access.tenantId, service_id: id, current_price_minor: cur.price_minor, proposed_price_minor: price_minor, proposed_by: actor.userId,
        }).returning('id').executeTakeFirstOrThrow();
        proposalId = p.id;
      }
    }
    if (fields.image_asset_id) await assertTenantAssets(trx, access.tenantId, [fields.image_asset_id]);
    await trx.updateTable('services').set({ ...fields, price_minor: newPrice, version: cur.version + 1 }).where('id', '=', id).execute();
    if (staff) await setServiceStaff(trx, access.tenantId, id, staff);
    if (resource_requirements) await setResourceRequirements(trx, access, id, resource_requirements);
    await audit(trx, actor, 'service.updated', { tenantId: access.tenantId, targetType: 'service', targetId: id, data: { fields: Object.keys(fields), price_from: cur.price_minor, price_to: newPrice, proposal: proposalId } });
    return { proposalId };
  });
  const svc = await getService(access, id);
  return { ...svc, pending_price_proposal_id: result.proposalId };
}

/** Archive instead of delete: history keeps referencing the service. */
export async function archiveService(access: TenantAccess, actor: AuditActor, id: string, archived: boolean) {
  return withTenant(access.tenantId, async (trx) => {
    const r = await trx.updateTable('services').set({ archived_at: archived ? new Date() : null, is_active: archived ? false : undefined, version: sql`version + 1` })
      .where('id', '=', id).returning('id').executeTakeFirst();
    if (!r) throw Errors.notFound('service');
    await audit(trx, actor, archived ? 'service.archived' : 'service.restored', { tenantId: access.tenantId, targetType: 'service', targetId: id });
    return { id, archived };
  });
}

export async function listPriceProposals(access: TenantAccess, status = 'proposed') {
  return withTenant(access.tenantId, (trx) => trx.selectFrom('service_price_proposals as p').innerJoin('services as s', 's.id', 'p.service_id')
    .select(['p.id', 'p.service_id', 's.name_ar', 's.name_en', 'p.current_price_minor', 'p.proposed_price_minor', 'p.reason', 'p.source', 'p.status', 'p.created_at'])
    .where('p.status', '=', status).orderBy('p.created_at', 'desc').execute());
}

export async function proposePrice(access: TenantAccess, actor: AuditActor, serviceId: string, input: z.infer<typeof priceProposalInput>, source: 'manual' | 'recommendation' = 'manual') {
  return withTenant(access.tenantId, async (trx) => {
    const s = await trx.selectFrom('services').select(['price_minor']).where('id', '=', serviceId).executeTakeFirst();
    if (!s) throw Errors.notFound('service');
    const p = await trx.insertInto('service_price_proposals').values({
      tenant_id: access.tenantId, service_id: serviceId, current_price_minor: s.price_minor, proposed_price_minor: input.proposed_price_minor,
      reason: input.reason ?? null, source, proposed_by: actor.userId,
    }).returningAll().executeTakeFirstOrThrow();
    await audit(trx, actor, 'service.price_proposed', { tenantId: access.tenantId, targetType: 'service', targetId: serviceId, data: { to: input.proposed_price_minor } });
    return p;
  });
}

/** Approving changes the catalog price only; confirmed bookings keep their snapshot. */
export async function decidePriceProposal(access: TenantAccess, actor: AuditActor, proposalId: string, decision: 'approved' | 'rejected') {
  if (!canApprovePrices(access)) throw Errors.forbidden('Only the owner can approve price changes');
  return withTenant(access.tenantId, async (trx) => {
    const p = await trx.selectFrom('service_price_proposals').selectAll().where('id', '=', proposalId).forUpdate().executeTakeFirst();
    if (!p) throw Errors.notFound('proposal');
    if (p.status !== 'proposed') throw Errors.conflict('already_decided');
    await trx.updateTable('service_price_proposals').set({ status: decision, decided_by: actor.userId, decided_at: new Date() }).where('id', '=', proposalId).execute();
    if (decision === 'approved') {
      await trx.updateTable('services').set({ price_minor: p.proposed_price_minor, version: sql`version + 1` }).where('id', '=', p.service_id).execute();
    }
    await audit(trx, actor, `service.price_${decision}`, { tenantId: access.tenantId, targetType: 'service', targetId: p.service_id, data: { from: p.current_price_minor, to: p.proposed_price_minor } });
    return { id: proposalId, status: decision };
  });
}

// ── Variants & add-ons ──────────────────────────────────────────────────────
async function assertService(trx: Tx, id: string) {
  const s = await trx.selectFrom('services').select('id').where('id', '=', id).executeTakeFirst();
  if (!s) throw Errors.notFound('service');
}

export async function createVariant(access: TenantAccess, actor: AuditActor, serviceId: string, input: z.infer<typeof variantInput>) {
  return withTenant(access.tenantId, async (trx) => {
    await assertService(trx, serviceId);
    const r = await trx.insertInto('service_variants').values({ tenant_id: access.tenantId, service_id: serviceId, ...input, name_ar: input.name_ar ?? null, name_en: input.name_en ?? null }).returningAll().executeTakeFirstOrThrow();
    await audit(trx, actor, 'service.variant_created', { tenantId: access.tenantId, targetType: 'service', targetId: serviceId });
    return r;
  });
}

export async function updateVariant(access: TenantAccess, variantId: string, input: Partial<z.infer<typeof variantInput>>) {
  return withTenant(access.tenantId, async (trx) => {
    const r = await trx.updateTable('service_variants').set(input).where('id', '=', variantId).returningAll().executeTakeFirst();
    if (!r) throw Errors.notFound('variant');
    return r;
  });
}

export async function createAddon(access: TenantAccess, actor: AuditActor, serviceId: string, input: z.infer<typeof addonInput>) {
  return withTenant(access.tenantId, async (trx) => {
    await assertService(trx, serviceId);
    const r = await trx.insertInto('service_addons').values({ tenant_id: access.tenantId, service_id: serviceId, ...input, name_ar: input.name_ar ?? null, name_en: input.name_en ?? null }).returningAll().executeTakeFirstOrThrow();
    await audit(trx, actor, 'service.addon_created', { tenantId: access.tenantId, targetType: 'service', targetId: serviceId });
    return r;
  });
}

export async function updateAddon(access: TenantAccess, addonId: string, input: Partial<z.infer<typeof addonInput>>) {
  return withTenant(access.tenantId, async (trx) => {
    const r = await trx.updateTable('service_addons').set(input).where('id', '=', addonId).returningAll().executeTakeFirst();
    if (!r) throw Errors.notFound('addon');
    return r;
  });
}

// ── Packages ────────────────────────────────────────────────────────────────
export async function listPackages(access: TenantAccess) {
  return withTenant(access.tenantId, async (trx) => {
    const pkgs = await trx.selectFrom('service_packages').selectAll().where('archived_at', 'is', null).orderBy('created_at').execute();
    const items = pkgs.length ? await trx.selectFrom('service_package_items').selectAll().where('package_id', 'in', pkgs.map((p) => p.id)).orderBy('sequence').execute() : [];
    return pkgs.map((p) => ({ ...p, service_ids: items.filter((i) => i.package_id === p.id).map((i) => i.service_id) }));
  });
}

export async function createPackage(access: TenantAccess, actor: AuditActor, input: z.infer<typeof packageInput>) {
  return withTenant(access.tenantId, async (trx) => {
    const { service_ids, ...fields } = input;
    const svc = await trx.selectFrom('services').select('id').where('id', 'in', service_ids).where('archived_at', 'is', null).execute();
    if (svc.length !== new Set(service_ids).size) throw Errors.invalid('invalid_reference', 'Every package service must exist in your catalog');
    const p = await trx.insertInto('service_packages').values({ tenant_id: access.tenantId, ...fields, name_ar: fields.name_ar ?? null, name_en: fields.name_en ?? null, description_ar: fields.description_ar ?? null, description_en: fields.description_en ?? null }).returningAll().executeTakeFirstOrThrow();
    await trx.insertInto('service_package_items').values(service_ids.map((sid, i) => ({ tenant_id: access.tenantId, package_id: p.id, service_id: sid, sequence: i }))).execute();
    await audit(trx, actor, 'package.created', { tenantId: access.tenantId, targetType: 'package', targetId: p.id });
    return { ...p, service_ids };
  });
}

export async function archivePackage(access: TenantAccess, actor: AuditActor, id: string) {
  return withTenant(access.tenantId, async (trx) => {
    const r = await trx.updateTable('service_packages').set({ archived_at: new Date(), is_active: false }).where('id', '=', id).returning('id').executeTakeFirst();
    if (!r) throw Errors.notFound('package');
    await audit(trx, actor, 'package.archived', { tenantId: access.tenantId, targetType: 'package', targetId: id });
    return r;
  });
}

// ── Resources ───────────────────────────────────────────────────────────────
export async function listResources(access: TenantAccess) {
  return withTenant(access.tenantId, async (trx) => ({
    types: await trx.selectFrom('resource_types').selectAll().orderBy('created_at').execute(),
    resources: await trx.selectFrom('resources').selectAll().orderBy('sort').execute(),
  }));
}

export async function createResourceType(access: TenantAccess, actor: AuditActor, input: { name_ar?: string | null; name_en?: string | null }) {
  return withTenant(access.tenantId, async (trx) => {
    const r = await trx.insertInto('resource_types').values({ tenant_id: access.tenantId, name_ar: input.name_ar ?? null, name_en: input.name_en ?? null }).returningAll().executeTakeFirstOrThrow();
    await audit(trx, actor, 'resource_type.created', { tenantId: access.tenantId, targetType: 'resource_type', targetId: r.id });
    return r;
  });
}

export async function createResource(access: TenantAccess, actor: AuditActor, input: { branch_id: string; resource_type_id: string; name: string }) {
  return withTenant(access.tenantId, async (trx) => {
    const r = await trx.insertInto('resources').values({ tenant_id: access.tenantId, ...input }).returningAll().executeTakeFirstOrThrow();
    await audit(trx, actor, 'resource.created', { tenantId: access.tenantId, targetType: 'resource', targetId: r.id });
    return r;
  });
}

export async function updateResource(access: TenantAccess, id: string, input: { name?: string; is_active?: boolean }) {
  return withTenant(access.tenantId, async (trx) => {
    const r = await trx.updateTable('resources').set(input).where('id', '=', id).returningAll().executeTakeFirst();
    if (!r) throw Errors.notFound('resource');
    return r;
  });
}

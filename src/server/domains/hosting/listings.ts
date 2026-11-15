import { DateTime } from 'luxon';
import { sql } from 'kysely';
import { withTenant, type Tx } from '../../db/client';
import { Errors } from '../../http/errors';
import { audit, type AuditActor } from '../../infra/audit';
import { requireFeature, requireWithinLimit, type TenantAccess } from '../../tenancy/access';
import { activeAccount } from '../payments/service';
import { busyBlocks, freeWindows } from './availability';
import { DISABLED_PRICE_MODELS, type ListingInput } from '@/shared/schemas/hosting';

/**
 * Host side («المساحات والاستضافة»): chair ↔ staff links (D1b) and listings.
 * Publishing is opt-in per space and per time window (D1b), requires the plan
 * feature, the space limit and an active payment account (D3c).
 */

// ── Chair ↔ staff links ─────────────────────────────────────────────────────
export async function listLinks(access: TenantAccess) {
  return withTenant(access.tenantId, async (trx) => {
    const resources = await trx.selectFrom('resources as r').leftJoin('resource_types as t', 't.id', 'r.resource_type_id')
      .select(['r.id', 'r.name', 'r.branch_id', 'r.is_active', 't.name_ar as type_name_ar', 't.name_en as type_name_en']).orderBy('r.sort').orderBy('r.name').execute();
    const links = await trx.selectFrom('resource_staff_links as l').innerJoin('staff_profiles as s', 's.id', 'l.staff_id')
      .select(['l.resource_id', 'l.staff_id', 's.display_name']).execute();
    return resources.map((r) => ({ ...r, staff: links.filter((l) => l.resource_id === r.id).map((l) => ({ staff_id: l.staff_id, display_name: l.display_name })) }));
  });
}

export async function setLinks(access: TenantAccess, actor: AuditActor, input: { resource_id: string; staff_ids: string[] }) {
  return withTenant(access.tenantId, async (trx) => {
    const r = await trx.selectFrom('resources').select(['id', 'branch_id']).where('id', '=', input.resource_id).executeTakeFirst();
    if (!r) throw Errors.notFound('resource');
    const ids = [...new Set(input.staff_ids)];
    if (ids.length) {
      const ok = await trx.selectFrom('staff_profiles').select('id').where('id', 'in', ids).where('archived_at', 'is', null).execute();
      if (ok.length !== ids.length) throw Errors.notFound('staff');
    }
    await trx.deleteFrom('resource_staff_links').where('resource_id', '=', r.id).execute();
    if (ids.length) await trx.insertInto('resource_staff_links').values(ids.map((s) => ({ tenant_id: access.tenantId, resource_id: r.id, staff_id: s, created_by: actor.userId }))).execute();
    await audit(trx, actor, 'hosting.chair_links_set', { tenantId: access.tenantId, targetType: 'resource', targetId: r.id, data: { staff_ids: ids } });
    return { resource_id: r.id, staff_ids: ids };
  });
}

// ── Listings ────────────────────────────────────────────────────────────────
const DEFAULTS = {
  space_type: 'chair', photo_asset_ids: [], specialties: [], min_duration_min: 60, max_duration_min: 480, setup_buffer_min: 0, cleanup_buffer_min: 0,
  price_model: 'fixed_hour', included_resource_ids: [], addons_discount_bp: 0, cancellation_terms: { free_until_hours: 24, fee_bp: 5000 },
  late_terms: { grace_min: 10, mode: 'per_15min', amount_minor: 0 }, booking_mode: 'approval', windows: [], addons: [],
} as const;

/** Column values from an input (only the keys present). */
function columns(input: Partial<ListingInput>) {
  const out: Record<string, unknown> = {};
  const plain = ['branch_id', 'resource_id', 'code', 'title_ar', 'title_en', 'space_type', 'description_ar', 'description_en', 'photo_asset_ids', 'specialties',
    'min_duration_min', 'max_duration_min', 'setup_buffer_min', 'cleanup_buffer_min', 'price_model', 'price_minor', 'period_min', 'percent_bp', 'percent_basis',
    'included_resource_ids', 'addons_discount_bp', 'own_materials_policy_ar', 'own_materials_policy_en', 'access_instructions_ar', 'access_instructions_en',
    'usage_rules_ar', 'usage_rules_en', 'booking_mode'] as const;
  for (const k of plain) if (input[k] !== undefined) out[k] = input[k];
  if (input.cancellation_terms) out.cancellation_terms = JSON.stringify(input.cancellation_terms);
  if (input.late_terms) out.late_terms = JSON.stringify(input.late_terms);
  return out;
}

async function validate(trx: Tx, merged: Partial<ListingInput> & { branch_id: string; resource_id: string }, listingId: string | null) {
  // D2: only fixed prices at launch; percentage models exist in the schema but are disabled.
  if ((DISABLED_PRICE_MODELS as readonly string[]).includes(merged.price_model ?? '') || merged.percent_bp != null || merged.percent_basis != null) {
    throw Errors.invalid('price_model_disabled', 'Percentage pricing is not available yet');
  }
  if (merged.price_model === 'fixed_period' && !merged.period_min) throw Errors.invalid('period_required', 'Set the period length');
  if ((merged.max_duration_min ?? 480) < (merged.min_duration_min ?? 60)) throw Errors.invalid('invalid_duration');
  const branch = await trx.selectFrom('branches').select('id').where('id', '=', merged.branch_id).executeTakeFirst();
  if (!branch) throw Errors.notFound('branch');
  const chair = await trx.selectFrom('resources').select(['id', 'branch_id']).where('id', '=', merged.resource_id).executeTakeFirst();
  if (!chair || chair.branch_id !== merged.branch_id) throw Errors.invalid('resource_not_at_branch', 'Choose a chair or room in this branch');
  const dup = await trx.selectFrom('workspace_listings').select('id').where('resource_id', '=', chair.id).where('status', '<>', 'archived')
    .$if(!!listingId, (q) => q.where('id', '<>', listingId!)).executeTakeFirst();
  if (dup) throw Errors.conflict('resource_already_listed', 'This space already has a listing');
  const extra = [...new Set([...(merged.included_resource_ids ?? []), ...(merged.addons ?? []).flatMap((a) => (a.kind === 'equipment' ? [a.resource_id] : []))])];
  if (extra.includes(chair.id)) throw Errors.invalid('invalid_equipment', 'The space itself cannot be an add-on');
  if (extra.length) {
    const ok = await trx.selectFrom('resources').select('id').where('id', 'in', extra).where('branch_id', '=', merged.branch_id).execute();
    if (ok.length !== extra.length) throw Errors.invalid('invalid_equipment', 'Equipment must be a resource of this branch');
  }
  const variants = [...new Set((merged.addons ?? []).flatMap((a) => (a.kind === 'product' ? [a.product_variant_id] : [])))];
  if (variants.length) {
    const ok = await trx.selectFrom('product_variants').select('id').where('id', 'in', variants).execute();
    if (ok.length !== variants.length) throw Errors.notFound('product');
  }
}

async function writeChildren(trx: Tx, tenantId: string, listingId: string, input: Partial<ListingInput>) {
  if (input.windows) {
    await trx.deleteFrom('workspace_listing_windows').where('listing_id', '=', listingId).execute();
    if (input.windows.length) await trx.insertInto('workspace_listing_windows').values(input.windows.map((w) => ({ tenant_id: tenantId, listing_id: listingId, weekday: w.weekday, start_time: w.start_time, end_time: w.end_time }))).execute();
  }
  if (input.addons) {
    // Old add-ons stay referenced by past bookings and requests: deactivate, never delete.
    await trx.updateTable('workspace_listing_addons').set({ is_active: false }).where('listing_id', '=', listingId).execute();
    if (input.addons.length) {
      await trx.insertInto('workspace_listing_addons').values(input.addons.map((a, i) => (a.kind === 'product'
        ? { tenant_id: tenantId, listing_id: listingId, kind: 'product', product_variant_id: a.product_variant_id, max_quantity: a.max_quantity ?? 5, sort: i }
        : { tenant_id: tenantId, listing_id: listingId, kind: 'equipment', resource_id: a.resource_id, name_ar: a.name_ar ?? null, name_en: a.name_en ?? null, rental_price_minor: a.rental_price_minor, rental_unit: a.rental_unit, max_quantity: 1, sort: i }))).execute();
    }
  }
}

export async function createListing(access: TenantAccess, actor: AuditActor, input: ListingInput) {
  return withTenant(access.tenantId, async (trx) => {
    const merged = { ...DEFAULTS, ...input } as ListingInput & typeof DEFAULTS;
    const count = await trx.selectFrom('workspace_listings').select(sql<number>`count(*)::int`.as('n')).where('status', '<>', 'archived').executeTakeFirstOrThrow();
    requireWithinLimit(access, 'limit.hosting_spaces', count.n);
    await validate(trx, merged, null);
    const row = await trx.insertInto('workspace_listings').values({
      tenant_id: access.tenantId, ...columns(merged), branch_id: merged.branch_id, resource_id: merged.resource_id, code: merged.code, price_minor: merged.price_minor,
      status: 'draft', created_by: actor.userId, updated_by: actor.userId,
    } as never).returning(['id']).executeTakeFirstOrThrow();
    await writeChildren(trx, access.tenantId, row.id, merged);
    await audit(trx, actor, 'hosting.listing_created', { tenantId: access.tenantId, targetType: 'workspace_listing', targetId: row.id, data: { code: input.code, price_model: merged.price_model, price_minor: input.price_minor } });
    return loadListing(trx, row.id);
  });
}

export async function updateListing(access: TenantAccess, actor: AuditActor, id: string, input: Partial<ListingInput> & { version: number }) {
  return withTenant(access.tenantId, async (trx) => {
    const cur = await trx.selectFrom('workspace_listings').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
    if (!cur) throw Errors.notFound('workspace_listing');
    if (cur.version !== input.version) throw Errors.versionConflict(cur.version);
    if (cur.status === 'archived') throw Errors.conflict('listing_archived');
    const { version: _v, ...patch } = input;
    const merged = {
      ...patch, branch_id: patch.branch_id ?? cur.branch_id, resource_id: patch.resource_id ?? cur.resource_id,
      price_model: (patch.price_model ?? cur.price_model) as ListingInput['price_model'], period_min: patch.period_min !== undefined ? patch.period_min : cur.period_min,
      min_duration_min: patch.min_duration_min ?? cur.min_duration_min, max_duration_min: patch.max_duration_min ?? cur.max_duration_min,
    };
    await validate(trx, merged, id);
    if (cur.status === 'published' && patch.price_minor === 0) throw Errors.invalid('price_required');
    // Every edit bumps the terms version: existing bookings keep their frozen snapshot (never repriced).
    await trx.updateTable('workspace_listings').set({ ...columns(patch), terms_version: sql`terms_version + 1`, version: sql`version + 1`, updated_by: actor.userId } as never)
      .where('id', '=', id).execute();
    await writeChildren(trx, access.tenantId, id, patch);
    await audit(trx, actor, 'hosting.listing_updated', { tenantId: access.tenantId, targetType: 'workspace_listing', targetId: id, data: { fields: Object.keys(patch) } });
    return loadListing(trx, id);
  });
}

export async function setListingStatus(access: TenantAccess, actor: AuditActor, id: string, input: { status: 'published' | 'paused' | 'draft' | 'archived'; version: number }) {
  return withTenant(access.tenantId, async (trx) => {
    const cur = await trx.selectFrom('workspace_listings').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
    if (!cur) throw Errors.notFound('workspace_listing');
    if (cur.version !== input.version) throw Errors.versionConflict(cur.version);
    if (cur.status === 'archived') throw Errors.conflict('listing_archived');
    if (input.status === 'published' && cur.status !== 'published') {
      requireFeature(access, 'hosting.publish');
      const published = await trx.selectFrom('workspace_listings').select(sql<number>`count(*)::int`.as('n')).where('status', '=', 'published').executeTakeFirstOrThrow();
      requireWithinLimit(access, 'limit.hosting_spaces', published.n);
      // D3c: rent is paid electronically to the salon, so publishing needs an active payment account.
      if (!(await activeAccount(trx, access.tenantId))) throw Errors.invalid('payment_account_required', 'Connect a payment account before publishing a space');
      const windows = await trx.selectFrom('workspace_listing_windows').select('id').where('listing_id', '=', id).limit(1).execute();
      if (!windows.length) throw Errors.invalid('windows_required', 'Choose when this space is offered');
      if (!(cur.price_minor > 0)) throw Errors.invalid('price_required', 'Set a price');
    }
    await trx.updateTable('workspace_listings').set({
      status: input.status, version: sql`version + 1`, updated_by: actor.userId, ...(input.status === 'published' ? { published_at: new Date() } : {}),
    }).where('id', '=', id).execute();
    await audit(trx, actor, `hosting.listing_${input.status}`, { tenantId: access.tenantId, targetType: 'workspace_listing', targetId: id, data: { from: cur.status } });
    return loadListing(trx, id);
  });
}

export async function loadListing(trx: Tx, id: string) {
  const l = await trx.selectFrom('workspace_listings as l').innerJoin('resources as r', 'r.id', 'l.resource_id').innerJoin('branches as b', 'b.id', 'l.branch_id')
    .selectAll('l').select(['r.name as resource_name', 'b.name as branch_name']).where('l.id', '=', id).executeTakeFirst();
  if (!l) throw Errors.notFound('workspace_listing');
  const windows = await trx.selectFrom('workspace_listing_windows').select(['weekday', 'start_time', 'end_time']).where('listing_id', '=', id).orderBy('weekday').orderBy('start_time').execute();
  const addons = await trx.selectFrom('workspace_listing_addons as a').leftJoin('product_variants as v', 'v.id', 'a.product_variant_id').leftJoin('products as p', 'p.id', 'v.product_id')
    .leftJoin('resources as r', 'r.id', 'a.resource_id')
    .select(['a.id', 'a.kind', 'a.product_variant_id', 'a.resource_id', 'a.name_ar', 'a.name_en', 'a.rental_price_minor', 'a.rental_unit', 'a.max_quantity',
      'v.price_minor as store_price_minor', 'p.name_ar as product_name_ar', 'p.name_en as product_name_en', 'r.name as resource_name'])
    .where('a.listing_id', '=', id).where('a.is_active', '=', true).orderBy('a.sort').execute();
  return { ...l, windows: windows.map((w) => ({ weekday: w.weekday, start_time: w.start_time.slice(0, 5), end_time: w.end_time.slice(0, 5) })), addons };
}

export async function listListings(access: TenantAccess) {
  return withTenant(access.tenantId, async (trx) => {
    const rows = await trx.selectFrom('workspace_listings as l').innerJoin('resources as r', 'r.id', 'l.resource_id').innerJoin('branches as b', 'b.id', 'l.branch_id')
      .select(['l.id', 'l.code', 'l.title_ar', 'l.title_en', 'l.space_type', 'l.status', 'l.price_model', 'l.price_minor', 'l.period_min', 'l.booking_mode', 'l.version', 'l.terms_version',
        'r.name as resource_name', 'b.name as branch_name'])
      .where('l.status', '<>', 'archived').orderBy('l.created_at').execute();
    return rows;
  });
}

export async function getListing(access: TenantAccess, id: string) {
  return withTenant(access.tenantId, (trx) => loadListing(trx, id));
}

/**
 * Internal vs rentable view for one local date: the offered windows, what is
 * busy (internal bookings, linked staff, freelancer bookings, blocks) and what
 * is still free to rent. Host only; nothing about the expert's clients.
 */
export async function hostAvailability(access: TenantAccess, id: string, dateISO: string) {
  return withTenant(access.tenantId, async (trx) => {
    const l = await trx.selectFrom('workspace_listings').select(['id', 'tenant_id', 'branch_id', 'resource_id', 'setup_buffer_min', 'cleanup_buffer_min']).where('id', '=', id).executeTakeFirst();
    if (!l) throw Errors.notFound('workspace_listing');
    const r = await freeWindows(trx, l, dateISO);
    const day = DateTime.fromISO(dateISO, { zone: r.tz });
    const all = await busyBlocks(trx, l, day.startOf('day').toJSDate(), day.endOf('day').toJSDate());
    const iso = (ms: number) => new Date(ms).toISOString();
    return {
      date: dateISO, timezone: r.tz,
      offered: r.offered.map((x) => ({ start: iso(x.start), end: iso(x.end) })),
      free: r.free.map((x) => ({ start: iso(x.start), end: iso(x.end) })),
      busy: all.filter((b) => b.kind !== 'equipment').map((b) => ({ start: iso(b.start), end: iso(b.end), kind: b.kind })),
    };
  });
}

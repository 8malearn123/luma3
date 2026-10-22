import { DateTime } from 'luxon';
import { sql } from 'kysely';
import type { Tx } from '../../db/client';
import { Errors } from '../../http/errors';
import type { EngineInput, ItemSpec, Range, StaffSchedule } from './engine';

export type RequestedItem = { key: string; serviceId: string; variantId?: string | null; addonIds?: string[]; staffId?: string | null };
export type Audience = 'public' | 'internal';

export type LoadedService = {
  id: string; name_ar: string | null; name_en: string | null; price_minor: number; duration_min: number; buffer_before_min: number; buffer_after_min: number;
  is_active: boolean; is_visible: boolean; bookable_internally_when_hidden: boolean; booking_mode: string; branch_id: string | null; category_id: string | null;
  min_notice_min: number | null; max_advance_days: number | null; requires_manual_approval: boolean; archived_at: Date | null;
};

export type ResolvedItem = {
  key: string;
  service: LoadedService;
  variant: { id: string; name_ar: string | null; name_en: string | null; price_minor: number; duration_min: number } | null;
  addons: Array<{ id: string; name_ar: string | null; name_en: string | null; price_minor: number; duration_min: number }>;
  /** Per qualified staff: price and duration (incl. add-ons), honouring per-specialist overrides. */
  staffTerms: Record<string, { priceMinor: number; durationMin: number; name: string }>;
  spec: ItemSpec;
};

const parseRange = (lower: Date, upper: Date): Range => ({ start: lower.getTime(), end: upper.getTime() });

/**
 * Validates the requested services and resolves durations, prices, qualified
 * staff and resource needs. Throws 422 with a specific code for anything that
 * cannot be booked (inactive, hidden for public, wrong branch, group service…).
 */
export async function resolveItems(trx: Tx, tenantId: string, branchId: string, items: RequestedItem[], audience: Audience): Promise<ResolvedItem[]> {
  if (!items.length || items.length > 6) throw Errors.invalid('invalid_items', 'Choose between 1 and 6 services');
  const keys = new Set(items.map((i) => i.key));
  if (keys.size !== items.length) throw Errors.invalid('invalid_items', 'Duplicate item keys');
  const serviceIds = [...new Set(items.map((i) => i.serviceId))];
  const services = await trx.selectFrom('services').selectAll().where('tenant_id', '=', tenantId).where('id', 'in', serviceIds).execute();
  const catIds = services.map((s) => s.category_id).filter(Boolean) as string[];
  const hiddenCats = catIds.length ? await trx.selectFrom('categories').select('id').where('id', 'in', catIds).where((eb) => eb.or([eb('is_visible', '=', false), eb('archived_at', 'is not', null)])).execute() : [];
  const variants = await trx.selectFrom('service_variants').selectAll().where('service_id', 'in', serviceIds).where('is_active', '=', true).execute();
  const addons = await trx.selectFrom('service_addons').selectAll().where('service_id', 'in', serviceIds).where('is_active', '=', true).execute();
  const staffLinks = await trx.selectFrom('service_staff as ss')
    .innerJoin('staff_profiles as sp', 'sp.id', 'ss.staff_id')
    .innerJoin('staff_branch_assignments as sba', (j) => j.onRef('sba.staff_id', '=', 'ss.staff_id').on('sba.branch_id', '=', branchId))
    .select(['ss.service_id', 'ss.staff_id', 'ss.price_override_minor', 'ss.duration_override_min', 'sp.display_name', 'sp.is_public'])
    .where('ss.service_id', 'in', serviceIds).where('sp.is_active', '=', true).where('sp.archived_at', 'is', null).execute();
  const reqs = await trx.selectFrom('service_resource_requirements').selectAll().where('service_id', 'in', serviceIds).execute();

  return items.map((req) => {
    const s = services.find((x) => x.id === req.serviceId);
    if (!s || s.archived_at) throw Errors.invalid('service_unavailable', 'This service is not available', { key: req.key });
    if (!s.is_active) throw Errors.invalid('service_inactive', 'This service is not taking new bookings', { key: req.key });
    const hidden = !s.is_visible || hiddenCats.some((c) => c.id === s.category_id);
    if (audience === 'public' && hidden) throw Errors.invalid('service_unavailable', 'This service is not available', { key: req.key });
    if (audience === 'internal' && hidden && !s.bookable_internally_when_hidden) throw Errors.invalid('service_unavailable', 'Hidden services are not bookable internally by policy', { key: req.key });
    if (s.booking_mode !== 'individual') throw Errors.invalid('group_service', 'Group sessions are booked from the session schedule', { key: req.key });
    if (s.branch_id && s.branch_id !== branchId) throw Errors.invalid('service_not_at_branch', 'This service is not offered at this branch', { key: req.key });
    const variant = req.variantId ? variants.find((v) => v.id === req.variantId && v.service_id === s.id) ?? null : null;
    if (req.variantId && !variant) throw Errors.invalid('invalid_variant', 'Unknown option', { key: req.key });
    const chosenAddons = (req.addonIds ?? []).map((id) => {
      const a = addons.find((x) => x.id === id && x.service_id === s.id);
      if (!a) throw Errors.invalid('invalid_addon', 'Unknown add-on', { key: req.key });
      return a;
    });
    if (new Set(req.addonIds ?? []).size !== (req.addonIds ?? []).length) throw Errors.invalid('invalid_addon', 'Duplicate add-on', { key: req.key });
    const addonMin = chosenAddons.reduce((a, x) => a + x.duration_min, 0);
    const addonPrice = chosenAddons.reduce((a, x) => a + x.price_minor, 0);
    let links = staffLinks.filter((l) => l.service_id === s.id && (audience === 'internal' || l.is_public));
    if (req.staffId) links = links.filter((l) => l.staff_id === req.staffId);
    if (!links.length) throw Errors.invalid(req.staffId ? 'staff_not_qualified' : 'no_qualified_staff', 'No qualified specialist is available for this service', { key: req.key });
    const staffTerms: ResolvedItem['staffTerms'] = {};
    for (const l of links) {
      // Variant wins over per-specialist override, which wins over the base service.
      const base = variant ? { p: variant.price_minor, d: variant.duration_min } : { p: l.price_override_minor ?? s.price_minor, d: l.duration_override_min ?? s.duration_min };
      staffTerms[l.staff_id] = { priceMinor: base.p + addonPrice, durationMin: base.d + addonMin, name: l.display_name };
    }
    return {
      key: req.key, service: s, variant: variant ? { id: variant.id, name_ar: variant.name_ar, name_en: variant.name_en, price_minor: variant.price_minor, duration_min: variant.duration_min } : null,
      addons: chosenAddons.map((a) => ({ id: a.id, name_ar: a.name_ar, name_en: a.name_en, price_minor: a.price_minor, duration_min: a.duration_min })),
      staffTerms,
      spec: {
        key: req.key, serviceId: s.id,
        durationByStaff: Object.fromEntries(Object.entries(staffTerms).map(([k, v]) => [k, v.durationMin])),
        bufferBefore: s.buffer_before_min, bufferAfter: s.buffer_after_min,
        qualifiedStaff: Object.keys(staffTerms),
        resourceNeeds: reqs.filter((r) => r.service_id === s.id).map((r) => ({ typeId: r.resource_type_id, quantity: r.quantity })),
      },
    };
  });
}

/**
 * Loads schedules, exceptions and current allocations for the staff/resources
 * involved, for local dates [from, to]. Unexpired holds count as busy; expired
 * holds do not (they are released lazily before allocating).
 */
export async function loadEngineInput(trx: Tx, tenantId: string, branchId: string, resolved: ResolvedItem[], fromISO: string, toISO: string, now = new Date()): Promise<EngineInput> {
  const settings = await trx.selectFrom('tenant_settings').selectAll().where('tenant_id', '=', tenantId).executeTakeFirstOrThrow();
  const branch = await trx.selectFrom('branches').select(['id', 'timezone', 'status']).where('id', '=', branchId).executeTakeFirst();
  if (!branch || branch.status !== 'active') throw Errors.invalid('branch_unavailable', 'This branch is not available');
  const tz = branch.timezone;
  const rangeStart = DateTime.fromISO(fromISO, { zone: tz }).startOf('day').minus({ hours: 12 }).toJSDate();
  const rangeEnd = DateTime.fromISO(toISO, { zone: tz }).endOf('day').plus({ hours: 12 }).toJSDate();
  const staffIds = [...new Set(resolved.flatMap((r) => r.spec.qualifiedStaff))];
  const typeIds = [...new Set(resolved.flatMap((r) => r.spec.resourceNeeds.map((n) => n.typeId)))];
  const window = sql`tstzrange(${rangeStart}, ${rangeEnd})`;

  const [hours, breaks, overrides, leave, blocks, allocs, sort, branchHours, resources, booked] = await Promise.all([
    trx.selectFrom('working_hours').selectAll().where('staff_id', 'in', staffIds).where('branch_id', '=', branchId).execute(),
    trx.selectFrom('staff_breaks').selectAll().where('staff_id', 'in', staffIds).execute(),
    trx.selectFrom('shift_overrides').selectAll().where('staff_id', 'in', staffIds).where('branch_id', '=', branchId).where('on_date', '>=', fromISO).where('on_date', '<=', toISO).execute(),
    trx.selectFrom('leave_requests').select(['staff_id', sql<Date>`lower(during)`.as('s'), sql<Date>`upper(during)`.as('e')])
      .where('staff_id', 'in', staffIds).where('status', '=', 'approved').where(sql<boolean>`during && ${window}`).execute(),
    trx.selectFrom('time_blocks').select(['staff_id', 'resource_id', sql<Date>`lower(during)`.as('s'), sql<Date>`upper(during)`.as('e')])
      .where('branch_id', '=', branchId).where(sql<boolean>`during && ${window}`).execute(),
    trx.selectFrom('booking_allocations').select(['staff_id', 'resource_id', sql<Date>`lower(during)`.as('s'), sql<Date>`upper(during)`.as('e')])
      .where(sql<boolean>`during && ${window}`)
      .where((eb) => eb.or([eb('state', '=', 'confirmed'), eb.and([eb('state', '=', 'held'), eb('expires_at', '>', now)])])).execute(),
    trx.selectFrom('staff_profiles').select(['id', 'sort']).where('id', 'in', staffIds).execute(),
    trx.selectFrom('branch_hours').selectAll().where('branch_id', '=', branchId).execute(),
    typeIds.length ? trx.selectFrom('resources').select(['id', 'resource_type_id']).where('branch_id', '=', branchId).where('is_active', '=', true).where('resource_type_id', 'in', typeIds).execute() : Promise.resolve([]),
    trx.selectFrom('booking_items as i').innerJoin('bookings as b', 'b.id', 'i.booking_id')
      .select(['i.staff_id', 'i.starts_at', 'i.duration_min'])
      .where('i.staff_id', 'in', staffIds).where('i.starts_at', '>=', rangeStart).where('i.starts_at', '<', rangeEnd)
      .where('b.status', 'in', ['held', 'pending_approval', 'pending_payment', 'confirmed', 'checked_in', 'in_service', 'completed']).execute(),
  ]);

  const staff: Record<string, StaffSchedule> = {};
  for (const id of staffIds) {
    staff[id] = {
      staffId: id,
      sort: sort.find((s) => s.id === id)?.sort ?? 0,
      weekly: hours.filter((h) => h.staff_id === id).map((h) => ({ weekday: h.weekday, start: h.start_time.slice(0, 5), end: h.end_time.slice(0, 5), effectiveFrom: h.effective_from, effectiveTo: h.effective_to })),
      breaks: breaks.filter((b) => b.staff_id === id).map((b) => ({ weekday: b.weekday, onDate: b.on_date, start: b.start_time.slice(0, 5), end: b.end_time.slice(0, 5) })),
      overrides: overrides.filter((o) => o.staff_id === id).map((o) => ({ onDate: o.on_date, kind: o.kind as 'off' | 'replace' | 'extra', start: o.start_time?.slice(0, 5) ?? null, end: o.end_time?.slice(0, 5) ?? null })),
      busy: [
        ...leave.filter((l) => l.staff_id === id).map((l) => parseRange(l.s, l.e)),
        ...blocks.filter((b) => b.staff_id === id).map((b) => parseRange(b.s, b.e)),
        ...allocs.filter((a) => a.staff_id === id).map((a) => parseRange(a.s, a.e)),
      ],
    };
  }
  const bookedMinutes: EngineInput['bookedMinutes'] = {};
  for (const b of booked) {
    const d = DateTime.fromJSDate(b.starts_at, { zone: tz }).toISODate()!;
    bookedMinutes[b.staff_id] ??= {};
    bookedMinutes[b.staff_id]![d] = (bookedMinutes[b.staff_id]![d] ?? 0) + b.duration_min;
  }
  // Service-level notice/window overrides: the strictest across selected services applies.
  const notice = Math.max(settings.min_notice_min, ...resolved.map((r) => r.service.min_notice_min ?? 0));
  const advance = Math.min(settings.max_advance_days, ...resolved.map((r) => r.service.max_advance_days ?? settings.max_advance_days));
  return {
    tz, now: now.getTime(), minNoticeMin: notice, maxAdvanceDays: advance, slotIncrementMin: settings.slot_increment_min,
    maxGapMin: settings.max_gap_between_items_min, anyStaffRule: settings.any_staff_rule as EngineInput['anyStaffRule'],
    branchHours: branchHours.map((h) => ({ weekday: h.weekday, opens: h.opens.slice(0, 5), closes: h.closes.slice(0, 5) })),
    staff,
    resources: resources.map((r) => ({
      resourceId: r.id, typeId: r.resource_type_id,
      busy: [...allocs.filter((a) => a.resource_id === r.id), ...blocks.filter((b) => b.resource_id === r.id)].map((a) => parseRange(a.s, a.e)),
    })),
    bookedMinutes,
  };
}

export async function primaryBranch(trx: Tx, tenantId: string) {
  const b = await trx.selectFrom('branches').select(['id', 'timezone']).where('tenant_id', '=', tenantId).where('status', '=', 'active').orderBy('is_primary', 'desc').orderBy('created_at').executeTakeFirst();
  if (!b) throw Errors.invalid('branch_unavailable');
  return b;
}

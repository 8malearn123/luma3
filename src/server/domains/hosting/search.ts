import { DateTime } from 'luxon';
import { sql } from 'kysely';
import { db, withTenant } from '../../db/client';
import { Errors } from '../../http/errors';
import type { TenantAccess } from '../../tenancy/access';
import { freeWindows, occupiedFor, fits } from './availability';
import { hostingTx } from './scope';
import { distanceKm, quote, type QuoteAddon, type SearchInput } from '@/shared/schemas/hosting';

/**
 * Expert search («احجزي مساحة عمل»). Public listing fields come from the
 * SECURITY DEFINER directory (published listings of active salons with an
 * active payment account only). Availability is computed in system scope and
 * only free/fits answers leave this module — never what occupies the chair.
 */
type Dir = {
  id: string; host_tenant_id: string; host_name: string; host_slug: string; branch_id: string; branch_name: string; city: string | null; address: string | null;
  latitude: string | number | null; longitude: string | number | null; timezone: string; code: string; title_ar: string | null; title_en: string | null; space_type: string;
  description_ar: string | null; description_en: string | null; photo_asset_ids: string[]; specialties: string[]; price_model: string; price_minor: number; period_min: number | null;
  currency: string; min_duration_min: number; max_duration_min: number; setup_buffer_min: number; cleanup_buffer_min: number; booking_mode: string; addons_discount_bp: number;
  own_materials_policy_ar: string | null; own_materials_policy_en: string | null; cancellation_terms: unknown; late_terms: unknown; usage_rules_ar: string | null; usage_rules_en: string | null;
  terms_version: number; windows: Array<{ weekday: number; start: string; end: string }>;
  addons: Array<{ id: string; kind: 'product' | 'equipment'; name_ar: string | null; name_en: string | null; unit_price_minor: number; rental_unit: 'booking' | 'hour' | null; max_quantity: number }>;
  included_equipment: string[]; rating_avg: string | number | null; rating_count: number; tax: { rate_bp: number; prices_include_tax: boolean; label: string | null; vat_registered: boolean };
};

async function directory(city: string | null, spaceType: string | null, listingId: string | null) {
  const r = await sql<Dir>`select * from app.workspace_directory(${city}, ${spaceType}, ${listingId})`.execute(db());
  return r.rows;
}

const num = (v: string | number | null) => (v == null ? null : Number(v));

function card(d: Dir, duration: number) {
  const q = quote({ price_model: d.price_model, price_minor: d.price_minor, period_min: d.period_min, addons_discount_bp: d.addons_discount_bp }, duration, [], d.tax);
  return {
    id: d.id, host: { name: d.host_name, slug: d.host_slug }, branch: { name: d.branch_name, city: d.city, address: d.address, latitude: num(d.latitude), longitude: num(d.longitude), timezone: d.timezone },
    code: d.code, title_ar: d.title_ar, title_en: d.title_en, space_type: d.space_type, description_ar: d.description_ar, description_en: d.description_en,
    photo_asset_ids: d.photo_asset_ids, specialties: d.specialties, price_model: d.price_model, price_minor: d.price_minor, period_min: d.period_min, currency: d.currency,
    min_duration_min: d.min_duration_min, max_duration_min: d.max_duration_min, booking_mode: d.booking_mode, addons_discount_bp: d.addons_discount_bp,
    addons: d.addons, included_equipment: d.included_equipment, rating: { average: num(d.rating_avg), count: d.rating_count, basis: 'completed_bookings_only' },
    tax: d.tax, terms_version: d.terms_version,
    // Base chair price for the requested duration (with tax); add-ons are priced in the quote before payment.
    base_total_minor: q.base_total_minor, rent_minor: q.rent_minor,
  };
}

/** Journey 2: a client appointment of hers → the window a compatible space must cover. */
async function windowFromAppointment(access: TenantAccess, bookingId: string) {
  return withTenant(access.tenantId, async (trx) => {
    const b = await trx.selectFrom('bookings').select(['id', 'timezone', 'status']).where('id', '=', bookingId).executeTakeFirst();
    if (!b) throw Errors.notFound('booking');
    const a = await trx.selectFrom('booking_allocations').select([sql<Date>`min(lower(during))`.as('s'), sql<Date>`max(upper(during))`.as('e')])
      .where('booking_id', '=', b.id).where('state', '<>', 'released').where('staff_id', 'is not', null).executeTakeFirst();
    if (!a?.s || !a.e) throw Errors.conflict('booking_not_active');
    return { start: a.s, end: a.e, tz: b.timezone };
  });
}

export async function searchSpaces(access: TenantAccess, input: SearchInput, now = new Date()) {
  let date = input.date, startTime = input.start_time ?? null, duration = input.duration_min;
  if (input.booking_id) {
    const w = await windowFromAppointment(access, input.booking_id);
    const s = DateTime.fromJSDate(w.start, { zone: w.tz });
    date = s.toISODate()!; startTime = s.toFormat('HH:mm');
    duration = Math.ceil((w.end.getTime() - w.start.getTime()) / 60_000);
  }
  const rows = (await directory(input.city ? `%${input.city}%` : null, input.space_type ?? null, null)).filter((d) => d.host_tenant_id !== access.tenantId);
  const wanted = (input.equipment ?? '').split(/[,،]/).map((x) => x.trim().toLowerCase()).filter(Boolean);
  const candidates = rows.filter((d) => {
    if (duration < d.min_duration_min || duration > d.max_duration_min) return false;
    if (input.specialty && d.specialties.length && !d.specialties.some((s) => s.toLowerCase() === input.specialty!.toLowerCase())) return false;
    return true;
  }).slice(0, 60);
  const resources = candidates.length ? await hostingTx('expert search: availability of published spaces', async (trx) => {
    const ls = await trx.selectFrom('workspace_listings').select(['id', 'tenant_id', 'branch_id', 'resource_id', 'setup_buffer_min', 'cleanup_buffer_min'])
      .where('id', 'in', candidates.map((c) => c.id)).where('status', '=', 'published').execute();
    const out = new Map<string, { free: Array<{ start: string; end: string }>; fits: boolean | null }>();
    for (const l of ls) {
      const d = candidates.find((c) => c.id === l.id)!;
      const r = await freeWindows(trx, l, date, { now });
      const occMin = (l.setup_buffer_min + l.cleanup_buffer_min) * 60_000;
      const free = r.free.filter((f) => f.end - f.start >= duration * 60_000 + occMin && f.end > now.getTime());
      let ok: boolean | null = null;
      if (startTime) {
        const start = DateTime.fromISO(`${date}T${startTime}`, { zone: d.timezone }).toJSDate();
        ok = start > now && fits(r.free, occupiedFor(l, start, new Date(start.getTime() + duration * 60_000)));
      }
      out.set(l.id, { free: free.map((f) => ({ start: new Date(f.start).toISOString(), end: new Date(f.end).toISOString() })), fits: ok });
    }
    return out;
  }) : new Map();

  const here = input.lat != null && input.lng != null ? { lat: input.lat, lng: input.lng } : null;
  let results = candidates.map((d) => {
    const c = card(d, duration);
    const a = resources.get(d.id) ?? { free: [], fits: null };
    const dist = here && c.branch.latitude != null && c.branch.longitude != null ? distanceKm(here, { lat: c.branch.latitude, lng: c.branch.longitude }) : null;
    const names = [...d.addons.filter((x) => x.kind === 'equipment').map((x) => `${x.name_ar ?? ''} ${x.name_en ?? ''}`), ...d.included_equipment].join(' ').toLowerCase();
    const fit = wanted.filter((w) => names.includes(w)).length;
    return { ...c, availability: a, distance_km: dist, equipment_fit: wanted.length ? { matched: fit, requested: wanted.length } : null };
  }).filter((r) => (startTime ? r.availability.fits : r.availability.free.length > 0));
  if (input.max_price_minor != null) results = results.filter((r) => r.base_total_minor <= input.max_price_minor!);
  // Distance filters apply only when both coordinates are known.
  if (input.max_distance_km != null && here) results = results.filter((r) => r.distance_km == null || r.distance_km <= input.max_distance_km!);
  if (wanted.length) results = results.filter((r) => (r.equipment_fit?.matched ?? 0) > 0);
  const nullsLast = (a: number | null, b: number | null, dir: 1 | -1) => (a == null ? (b == null ? 0 : 1) : b == null ? -1 : (a - b) * dir);
  const by = {
    price: (a: typeof results[number], b: typeof results[number]) => a.base_total_minor - b.base_total_minor,
    distance: (a: typeof results[number], b: typeof results[number]) => nullsLast(a.distance_km, b.distance_km, 1),
    rating: (a: typeof results[number], b: typeof results[number]) => nullsLast(a.rating.average, b.rating.average, -1) || b.rating.count - a.rating.count,
    equipment_fit: (a: typeof results[number], b: typeof results[number]) => (b.equipment_fit?.matched ?? 0) - (a.equipment_fit?.matched ?? 0),
  }[input.sort];
  results.sort((a, b) => by(a, b) || a.base_total_minor - b.base_total_minor || a.id.localeCompare(b.id));
  return { date, start_time: startTime, duration_min: duration, sort: input.sort, distance_available: !!here, results };
}

/** Listing details for an expert: full price, terms, inclusions/exclusions, reviews and the day's free windows. */
export async function listingDetail(access: TenantAccess, id: string, opts: { date?: string; duration_min?: number }, now = new Date()) {
  const d = (await directory(null, null, id))[0];
  if (!d || d.host_tenant_id === access.tenantId) throw Errors.notFound('workspace_listing');
  const duration = opts.duration_min ?? d.min_duration_min;
  const reviews = (await sql<{ rating: number; body: string | null; created_at: Date }>`select * from app.workspace_listing_reviews(${id}, 10)`.execute(db())).rows;
  const date = opts.date ?? DateTime.now().setZone(d.timezone).toISODate()!;
  const free = await hostingTx('expert views a published space: free windows', async (trx) => {
    const l = await trx.selectFrom('workspace_listings').select(['id', 'tenant_id', 'branch_id', 'resource_id', 'setup_buffer_min', 'cleanup_buffer_min']).where('id', '=', id).executeTakeFirstOrThrow();
    const r = await freeWindows(trx, l, date, { now });
    return r.free.map((f) => ({ start: new Date(f.start).toISOString(), end: new Date(f.end).toISOString() }));
  });
  return {
    ...card(d, duration), windows: d.windows, own_materials_policy_ar: d.own_materials_policy_ar, own_materials_policy_en: d.own_materials_policy_en,
    cancellation_terms: d.cancellation_terms, late_terms: d.late_terms, usage_rules_ar: d.usage_rules_ar, usage_rules_en: d.usage_rules_en,
    setup_buffer_min: d.setup_buffer_min, cleanup_buffer_min: d.cleanup_buffer_min,
    // D5: nothing is included except the listed equipment; she brings her own materials or buys from the salon store.
    inclusions: { equipment: d.included_equipment, materials: [] as string[] },
    reviews, date, free,
  };
}

/** Price before payment: base chair price vs total with the chosen add-ons (store prices, discount, tax). */
export async function quoteSpace(access: TenantAccess, input: { listing_id: string; duration_min: number; addons: Array<{ addon_id: string; quantity: number }> }) {
  const d = (await directory(null, null, input.listing_id))[0];
  if (!d || d.host_tenant_id === access.tenantId) throw Errors.notFound('workspace_listing');
  if (input.duration_min < d.min_duration_min || input.duration_min > d.max_duration_min) throw Errors.invalid('invalid_duration');
  const addons: QuoteAddon[] = input.addons.map((x) => {
    const a = d.addons.find((y) => y.id === x.addon_id);
    if (!a) throw Errors.invalid('invalid_addon', 'Unknown add-on', { addon_id: x.addon_id });
    if (x.quantity > a.max_quantity) throw Errors.invalid('addon_quantity');
    return { addon_id: a.id, kind: a.kind, name: a.name_ar ?? a.name_en ?? '', quantity: x.quantity, unit_price_minor: a.unit_price_minor, rental_unit: a.rental_unit };
  });
  const q = quote({ price_model: d.price_model, price_minor: d.price_minor, period_min: d.period_min, addons_discount_bp: d.addons_discount_bp }, input.duration_min, addons, d.tax);
  return { ...q, currency: d.currency, terms_version: d.terms_version, tax: d.tax };
}

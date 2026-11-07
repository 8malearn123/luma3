import { sql } from 'kysely';
import { db, withCentral } from '../../db/client';
import { Errors } from '../../http/errors';
import { assetUrl } from '../assets/service';
import { DOORS, haversineKm, type Door } from './rules';

/**
 * Public marketplace read model (سوق لوما). Every row comes from the narrow
 * security-definer function app.marketplace_directory(), which only returns
 * approved + visible + active + published (+ verified when required)
 * businesses and allowlisted columns. The internal tenant id never leaves this
 * module: public responses identify businesses by slug.
 */

type Specialty = { slug: string; name_ar: string | null; name_en: string | null };
export type DirectoryRow = {
  id: string; slug: string; name: string; business_type: string; city: string | null; currency: string;
  tagline_ar: string | null; tagline_en: string | null; logo_asset_id: string | null; cover_asset_id: string | null; verified: boolean;
  rating_avg: number | null; rating_count: number; min_price_minor: number | null; specialties: Specialty[]; search_text: string;
  latitude: number | null; longitude: number | null; completed_90d: number; listed_at: Date | null;
};

export async function directoryRows(): Promise<DirectoryRow[]> {
  const r = await sql<DirectoryRow>`select * from app.marketplace_directory()`.execute(db());
  return r.rows.map((x) => ({
    ...x,
    rating_avg: x.rating_avg == null ? null : Number(x.rating_avg),
    latitude: x.latitude == null ? null : Number(x.latitude),
    longitude: x.longitude == null ? null : Number(x.longitude),
    min_price_minor: x.min_price_minor == null ? null : Number(x.min_price_minor),
  }));
}

export const SORTS = ['best', 'nearest', 'top_rated', 'most_booked', 'price_asc', 'price_desc'] as const;
export type MarketSort = (typeof SORTS)[number];

export type SearchQuery = {
  q?: string; door?: Door; type?: string; specialty?: string; city?: string; min_rating?: number;
  price_min?: number; price_max?: number; sort: MarketSort; lat?: number; lng?: number; page: number; limit: number;
};

export type MarketCard = {
  slug: string; name: string; business_type: string; city: string | null; tagline_ar: string | null; tagline_en: string | null;
  logo_url: string | null; cover_url: string | null; verified: boolean; rating_avg: number | null; rating_count: number;
  starting_price_minor: number | null; currency: string; specialties: Specialty[]; distance_km: number | null; favorite: boolean;
};

const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();

export function toCard(r: DirectoryRow, opts: { favorites?: Set<string>; lat?: number; lng?: number } = {}): MarketCard {
  const distance = opts.lat != null && opts.lng != null && r.latitude != null && r.longitude != null
    ? Math.round(haversineKm(opts.lat, opts.lng, r.latitude, r.longitude) * 10) / 10 : null;
  return {
    slug: r.slug, name: r.name, business_type: r.business_type, city: r.city, tagline_ar: r.tagline_ar, tagline_en: r.tagline_en,
    logo_url: r.logo_asset_id ? assetUrl(r.logo_asset_id) : null, cover_url: r.cover_asset_id ? assetUrl(r.cover_asset_id) : null,
    verified: r.verified, rating_avg: r.rating_avg == null ? null : Math.round(r.rating_avg * 10) / 10, rating_count: r.rating_count,
    starting_price_minor: r.min_price_minor, currency: r.currency, specialties: (r.specialties ?? []).slice(0, 4),
    distance_km: distance, favorite: !!opts.favorites?.has(r.id),
  };
}

function matchesSpecialty(r: DirectoryRow, s: string) {
  const k = norm(s);
  return (r.specialties ?? []).some((c) => norm(c.name_ar) === k || norm(c.name_en) === k || c.slug === k);
}

/** Relevance: name match beats specialty/service match; then quality signals. */
function bestScore(r: DirectoryRow, q: string) {
  let text = 0;
  if (q) {
    const n = norm(r.name);
    text = n === q ? 40 : n.startsWith(q) ? 30 : n.includes(q) ? 20 : (r.specialties ?? []).some((c) => norm(c.name_ar).includes(q) || norm(c.name_en).includes(q)) ? 12 : 6;
  }
  return text + (r.rating_avg ?? 0) * Math.log(r.rating_count + 2) + Math.log(r.completed_90d + 1) + (r.verified ? 1 : 0);
}

export function applySearch(rows: DirectoryRow[], q: SearchQuery) {
  const term = norm(q.q);
  const types: readonly string[] | null = q.type ? [q.type] : q.door ? DOORS[q.door] : null;
  // Facets reflect the door/type only, so the filter lists don't collapse while filtering.
  const scope = rows.filter((r) => !types || types.includes(r.business_type));
  let list = scope.filter((r) =>
    (!term || r.search_text.includes(term))
    && (!q.specialty || matchesSpecialty(r, q.specialty))
    && (!q.city || norm(r.city) === norm(q.city))
    && (q.min_rating == null || (r.rating_avg ?? 0) >= q.min_rating)
    && (q.price_min == null || (r.min_price_minor != null && r.min_price_minor >= q.price_min))
    && (q.price_max == null || (r.min_price_minor != null && r.min_price_minor <= q.price_max)));

  const geo = q.lat != null && q.lng != null;
  const dist = (r: DirectoryRow) => (geo && r.latitude != null && r.longitude != null ? haversineKm(q.lat!, q.lng!, r.latitude, r.longitude) : Number.POSITIVE_INFINITY);
  const byName = (a: DirectoryRow, b: DirectoryRow) => a.name.localeCompare(b.name, 'ar') || a.slug.localeCompare(b.slug);
  const sorters: Record<MarketSort, (a: DirectoryRow, b: DirectoryRow) => number> = {
    best: (a, b) => bestScore(b, term) - bestScore(a, term) || byName(a, b),
    nearest: (a, b) => dist(a) - dist(b) || bestScore(b, term) - bestScore(a, term) || byName(a, b),
    top_rated: (a, b) => (b.rating_avg ?? -1) - (a.rating_avg ?? -1) || b.rating_count - a.rating_count || byName(a, b),
    most_booked: (a, b) => b.completed_90d - a.completed_90d || byName(a, b),
    price_asc: (a, b) => (a.min_price_minor ?? Number.MAX_SAFE_INTEGER) - (b.min_price_minor ?? Number.MAX_SAFE_INTEGER) || byName(a, b),
    price_desc: (a, b) => (b.min_price_minor ?? -1) - (a.min_price_minor ?? -1) || byName(a, b),
  };
  list = [...list].sort(sorters[q.sort]);

  const cities = new Map<string, number>();
  const specialties = new Map<string, { name_ar: string | null; name_en: string | null; count: number }>();
  let pmin: number | null = null, pmax: number | null = null;
  for (const r of scope) {
    if (r.city) cities.set(r.city, (cities.get(r.city) ?? 0) + 1);
    const seen = new Set<string>();
    for (const c of r.specialties ?? []) {
      const key = norm(c.name_ar || c.name_en);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const cur = specialties.get(key);
      if (cur) cur.count += 1; else specialties.set(key, { name_ar: c.name_ar, name_en: c.name_en, count: 1 });
    }
    if (r.min_price_minor != null) { pmin = Math.min(pmin ?? r.min_price_minor, r.min_price_minor); pmax = Math.max(pmax ?? r.min_price_minor, r.min_price_minor); }
  }
  const total = list.length;
  const start = (q.page - 1) * q.limit;
  return {
    rows: list.slice(start, start + q.limit), total, page: q.page, limit: q.limit,
    facets: {
      cities: [...cities].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ar')),
      specialties: [...specialties].map(([key, v]) => ({ key, ...v })).sort((a, b) => b.count - a.count).slice(0, 40),
      price: { min: pmin, max: pmax },
    },
  };
}

export async function favoriteIds(userId: string | null | undefined): Promise<Set<string>> {
  if (!userId) return new Set();
  const rows = await withCentral((trx) => trx.selectFrom('customer_favorites').select('business_id').where('user_id', '=', userId).execute());
  return new Set(rows.map((r) => r.business_id));
}

export async function searchMarketplace(q: SearchQuery, userId?: string | null) {
  const [rows, favs] = await Promise.all([directoryRows(), favoriteIds(userId)]);
  const res = applySearch(rows, q);
  return { items: res.rows.map((r) => toCard(r, { favorites: favs, lat: q.lat, lng: q.lng })), total: res.total, page: res.page, limit: res.limit, facets: res.facets };
}

/** Hub highlights: a few top-rated businesses per door. */
export async function marketplaceHighlights(limit = 8, favorites?: Set<string>) {
  const rows = await directoryRows();
  const pick = (door: Door) => applySearch(rows, { door, sort: 'top_rated', page: 1, limit }).rows.map((r) => toCard(r, { favorites }));
  return { salons: pick('salons'), experts: pick('experts'), total: rows.length, counts: { salons: rows.filter((r) => (DOORS.salons as readonly string[]).includes(r.business_type)).length, experts: rows.filter((r) => r.business_type === 'expert').length } };
}

// ── Favourites (signed-in customers) ─────────────────────────────────────────
async function listedBySlug(slug: string) {
  if (!/^[a-z0-9-]{3,48}$/.test(slug)) throw Errors.notFound('business');
  const r = await sql<{ id: string }>`select id from app.marketplace_directory() where slug = ${slug}`.execute(db());
  const row = r.rows[0];
  if (!row) throw Errors.notFound('business');
  return row.id;
}

/** Only businesses currently listed in the marketplace can be added. Idempotent. */
export async function addFavorite(userId: string, slug: string) {
  const id = await listedBySlug(slug);
  await withCentral((trx) => trx.insertInto('customer_favorites').values({ user_id: userId, business_id: id })
    .onConflict((oc) => oc.columns(['user_id', 'business_id']).doNothing()).execute());
  return { slug, favorite: true };
}

export async function removeFavorite(userId: string, slug: string) {
  if (!/^[a-z0-9-]{3,48}$/.test(slug)) throw Errors.notFound('business');
  // Removal works even when the business is no longer listed.
  await withCentral(async (trx) => {
    const r = await sql<{ id: string }>`select id from app.resolve_tenant_slug(${slug})`.execute(trx);
    if (r.rows[0]) await trx.deleteFrom('customer_favorites').where('user_id', '=', userId).where('business_id', '=', r.rows[0].id).execute();
  });
  return { slug, favorite: false };
}

/**
 * «استكشفي»: the customer's favourites (currently listed ones) and simple
 * suggestions — same city as her favourites (or the city she passes), then top
 * rated — excluding favourites.
 */
export async function explore(userId: string, opts: { city?: string } = {}) {
  const [rows, favs] = await Promise.all([directoryRows(), favoriteIds(userId)]);
  const favorites = rows.filter((r) => favs.has(r.id));
  const cities = new Set([opts.city, ...favorites.map((r) => r.city)].filter((c): c is string => !!c).map(norm));
  const candidates = rows.filter((r) => !favs.has(r.id));
  const ranked = [...candidates].sort((a, b) =>
    Number(cities.has(norm(b.city))) - Number(cities.has(norm(a.city)))
    || (b.rating_avg ?? -1) - (a.rating_avg ?? -1) || b.rating_count - a.rating_count || a.slug.localeCompare(b.slug));
  return {
    favorites: favorites.map((r) => toCard(r, { favorites: favs })),
    suggestions: ranked.slice(0, 8).map((r) => ({ ...toCard(r, { favorites: favs }), reason: cities.has(norm(r.city)) ? 'same_city' as const : 'top_rated' as const })),
  };
}

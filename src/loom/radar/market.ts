import { z } from 'zod';
import { audit, Errors, withTenant, type AuditActor, type Tx } from '../db';
import type { AssessedOpportunity } from '../opportunities/engine';
import { L, median, render, type Localized, type LoomLocale } from '../util/text';
import { businessContext } from './context';
import { parseHtml } from './parse';
import { radarFetcher } from './ports';
import { RadarFetchError } from './types';

/**
 * Market observations (§12.3). Competitor offers, price points, audience
 * needs and channel norms with source, date, region and comparability.
 *
 * HARD RULE (T15): a competitor price alone never yields a price-decrease
 * suggestion. Market prices are CONTEXT next to the business's own margin,
 * demand and quality; `may_decrease_price` is always false, the engine strips
 * any price cut whose only basis is the market (enforceNoMarketPriceCut), and
 * a Loom price proposal below the current price is refused (api/service).
 */
export const MARKET_KINDS = ['competitor_offer', 'price_point', 'audience_need', 'channel_norm'] as const;
export const COMPARABILITY = ['comparable', 'partial', 'not_comparable'] as const;
export const COMPARABILITY_REASONS = ['different_duration', 'different_components', 'different_quality', 'different_region', 'different_audience', 'unknown_details', 'no_matching_offering'] as const;
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const marketObservationInput = z.object({
  kind: z.enum(MARKET_KINDS),
  offering_id: z.string().uuid().nullable().default(null),
  competitor: z.string().trim().max(120).nullable().default(null),
  note: z.string().trim().min(2).max(1000),
  price_minor: z.number().int().min(0).max(100_000_000).nullable().default(null),
  source: z.enum(['manual', 'link']).default('manual'),
  source_url: z.string().url().max(500).regex(/^https:\/\//).nullable().default(null),
  observed_on: isoDate,
  region: z.string().trim().max(40).nullable().default(null),
  comparability: z.enum(COMPARABILITY),
  comparability_reasons: z.array(z.enum(COMPARABILITY_REASONS)).max(7).default([]),
}).strict()
  .refine((v) => v.price_minor === null || v.kind === 'competitor_offer' || v.kind === 'price_point', { message: 'price only for competitor offers and price points', path: ['price_minor'] })
  .refine((v) => v.comparability === 'comparable' || v.comparability_reasons.length > 0, { message: 'give the reasons why it is not comparable', path: ['comparability_reasons'] })
  .refine((v) => v.source === 'manual' || !!v.source_url, { message: 'a link is required', path: ['source_url'] });
export const marketObservationPatch = z.object({
  note: z.string().trim().min(2).max(1000).optional(),
  comparability: z.enum(COMPARABILITY).optional(),
  comparability_reasons: z.array(z.enum(COMPARABILITY_REASONS)).max(7).optional(),
  archived: z.boolean().optional(),
}).strict().refine((v) => Object.keys(v).length > 0, { message: 'empty' });

type Ctx = { businessId: string; actor: AuditActor; locale: LoomLocale };

export type PriceContext = {
  offering_id: string; our_price_minor: number | null; observations: number; comparable_prices: number; median_comparable_minor: number | null;
  position: 'below_market' | 'similar' | 'above_market' | 'unknown'; may_decrease_price: false; note: Localized;
};

/** Pure: market price context for one offering. Only comparable/partial observations with a price count. */
export function marketPriceContext(offeringId: string, ourPrice: number | null, obs: Array<{ offering_id: string | null; price_minor: number | null; comparability: string; kind: string }>): PriceContext {
  const mine = obs.filter((o) => o.offering_id === offeringId);
  const prices = mine.filter((o) => o.price_minor !== null && o.comparability !== 'not_comparable').map((o) => o.price_minor!);
  const med = median(prices);
  const position = med === null || ourPrice === null ? 'unknown' : ourPrice > med * 1.1 ? 'above_market' : ourPrice < med * 0.9 ? 'below_market' : 'similar';
  return {
    offering_id: offeringId, our_price_minor: ourPrice, observations: mine.length, comparable_prices: prices.length, median_comparable_minor: med, position, may_decrease_price: false,
    note: L('أسعار المنافسين سياق فقط: لا تكفي وحدها لاقتراح خفض السعر، وتُقرأ مع هامشك وطلبك وجودة خدمتك.',
      'Competitor prices are context only: on their own they never justify a price decrease; read them with your margin, demand and quality.'),
  };
}

/**
 * Pure engine guard (T15): adds the market context note to every opportunity
 * on an offering that has market observations, and removes any opportunity
 * that would DECREASE a price on market grounds. (The intervention selector
 * only ever proposes an increase review; this guard keeps that invariant even
 * if a future detector or pack tries otherwise.)
 */
export function enforceNoMarketPriceCut(opps: AssessedOpportunity[], observedOfferings: Set<string>): { kept: AssessedOpportunity[]; removed: Array<{ fingerprint: string; reason: 'market_price_decrease' }> } {
  const kept: AssessedOpportunity[] = [];
  const removed: Array<{ fingerprint: string; reason: 'market_price_decrease' }> = [];
  for (const o of opps) {
    const a = o.card.recommended_action as { kind: string; intervention_id: string; direction?: string | null };
    const onObserved = o.subject.offering_ids.some((id) => observedOfferings.has(id));
    // Any explicit price direction other than an increase review, or a price-review intervention without one, is a cut.
    const decrease = (!!a.direction && a.direction !== 'increase_review') || (a.intervention_id === 'price_review' && a.direction !== 'increase_review');
    if (decrease) { removed.push({ fingerprint: o.fingerprint, reason: 'market_price_decrease' }); continue; }
    if (onObserved && !o.card.limitations.some((l) => l.en.startsWith('Competitor prices are context only'))) {
      o.card.limitations.push(marketPriceContext('', null, []).note);
    }
    kept.push(o);
  }
  return { kept, removed };
}

/** Pure: may Loom propose this price? Never below the current price (no internal basis for a cut exists in v1). */
export function priceProposalAllowed(current: number | null, proposed: number): { allowed: boolean; reason: 'price_decrease_not_supported' | null } {
  return current !== null && proposed < current ? { allowed: false, reason: 'price_decrease_not_supported' } : { allowed: true, reason: null };
}

export async function addMarketObservation(c: Ctx, raw: z.input<typeof marketObservationInput>) {
  const input = marketObservationInput.parse(raw);
  const { offerings } = await businessContext(c.businessId);
  if (input.offering_id && !offerings.some((o) => o.id === input.offering_id)) throw Errors.invalid('unknown_offering', 'Choose one of your active offerings');
  let comparability = input.comparability;
  let reasons = [...input.comparability_reasons];
  // A price with no matching offering of ours cannot be compared.
  if (input.price_minor !== null && !input.offering_id) { comparability = 'not_comparable'; if (!reasons.includes('no_matching_offering')) reasons.push('no_matching_offering'); }
  let untrusted_title: string | null = null, untrusted_excerpt: string | null = null, link_status: 'fetched' | 'unreachable' | null = null;
  if (input.source === 'link' && input.source_url) {
    try { await radarFetcher().assertPublic(input.source_url); } catch (e) {
      throw Errors.invalid('blocked_url', 'This address cannot be used', { reason: e instanceof RadarFetchError ? e.code : 'invalid_url' });
    }
    try {
      const res = await radarFetcher().fetch(input.source_url, 'html');
      const p = parseHtml(res.text)[0];
      untrusted_title = p?.untrusted_title ?? null; untrusted_excerpt = p?.untrusted_summary ?? null; link_status = 'fetched';
    } catch { link_status = 'unreachable'; }
  }
  const row = await withTenant(c.businessId, async (trx) => {
    const r = await trx.insertInto('loom.market_observations').values({
      business_id: c.businessId, kind: input.kind, offering_id: input.offering_id, competitor: input.competitor, note: input.note, price_minor: input.price_minor,
      source_type: input.source, source_url: input.source_url, untrusted_title, untrusted_excerpt, link_status, observed_on: input.observed_on, region: input.region,
      comparability, comparability_reasons: reasons, created_by: c.actor.userId,
    }).returningAll().executeTakeFirstOrThrow();
    await audit(trx, c.actor, 'loom.market_observation_added', { tenantId: c.businessId, targetType: 'loom_market_observation', targetId: r.id, data: { kind: r.kind, comparability } });
    return r;
  });
  return row;
}

export async function updateMarketObservation(c: Ctx, id: string, raw: z.input<typeof marketObservationPatch>) {
  const p = marketObservationPatch.parse(raw);
  return withTenant(c.businessId, async (trx) => {
    const cur = await trx.selectFrom('loom.market_observations').selectAll().where('business_id', '=', c.businessId).where('id', '=', id).executeTakeFirst();
    if (!cur) throw Errors.notFound('market_observation');
    const comparability = p.comparability ?? cur.comparability;
    const reasons = p.comparability_reasons ?? cur.comparability_reasons;
    if (comparability !== 'comparable' && !reasons.length) throw Errors.invalid('reasons_required', 'Give the reasons why it is not comparable');
    if (comparability !== 'not_comparable' && cur.price_minor !== null && !cur.offering_id) throw Errors.invalid('no_matching_offering', 'A price without a matching offering cannot be comparable');
    const r = await trx.updateTable('loom.market_observations').set({
      note: p.note ?? cur.note, comparability, comparability_reasons: reasons, archived_at: p.archived === undefined ? cur.archived_at : p.archived ? new Date() : null,
    }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
    await audit(trx, c.actor, 'loom.market_observation_updated', { tenantId: c.businessId, targetType: 'loom_market_observation', targetId: id, data: { keys: Object.keys(p) } });
    return r;
  });
}

export async function listMarketObservations(c: Pick<Ctx, 'businessId' | 'locale'>, opts: { archived?: boolean } = {}) {
  const { offerings } = await businessContext(c.businessId);
  const rows = await withTenant(c.businessId, (trx) => {
    let q = trx.selectFrom('loom.market_observations').selectAll().where('business_id', '=', c.businessId);
    q = opts.archived ? q.where('archived_at', 'is not', null) : q.where('archived_at', 'is', null);
    return q.orderBy('observed_on', 'desc').orderBy('created_at', 'desc').limit(200).execute();
  });
  const observed = [...new Set(rows.map((r) => r.offering_id).filter((x): x is string => !!x))];
  return {
    observations: rows.map((r) => ({ ...r, offering_name: r.offering_id ? render(offerings.find((o) => o.id === r.offering_id)?.name, c.locale) || null : null })),
    price_context: observed.map((id) => { const pc = marketPriceContext(id, offerings.find((o) => o.id === id)?.price_minor ?? null, rows); return { ...pc, note: render(pc.note, c.locale) }; }),
    offerings: offerings.map((o) => ({ id: o.id, name: render(o.name, c.locale), price_minor: o.price_minor })),
  };
}

/** Offerings with active observations (engine guard input). */
export async function observedOfferings(trx: Tx, businessId: string): Promise<Set<string>> {
  const rows = await (trx.selectFrom('loom.market_observations').select('offering_id').where('business_id', '=', businessId).where('archived_at', 'is', null).where('offering_id', 'is not', null).execute());
  return new Set(rows.map((r) => r.offering_id!));
}

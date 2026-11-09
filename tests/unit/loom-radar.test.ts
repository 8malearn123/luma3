import { describe, expect, it } from 'vitest';
import {
  beautyPack, checkAwarenessRule, clusterSignals, dedupeKeyOf, enforceNoMarketPriceCut, eventRelevance, evidenceClassOf, isAwarenessOnly, marketPriceContext,
  parseFeed, parseIcs, parseJsonItems, priceProposalAllowed, regionFit, SA_STARTER_CALENDAR, signalFreshness, signalRelevance, titleTokens,
  type AssessedOpportunity, type ClusterInput, type RelevanceContext,
} from '@/loom';

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-09T12:00:00Z');
let n = 0;
const sig = (o: Partial<ClusterInput> & { title: string; days: number | null; source?: string }): ClusterInput => ({
  id: `00000000-0000-0000-0000-${String(++n).padStart(12, '0')}`, source_id: o.source ?? 's1', topic: o.topic ?? null, tokens: titleTokens(o.title), untrusted_title: o.title,
  published_at: o.days === null ? null : NOW - o.days * DAY, observed_at: NOW, dedupe_key: dedupeKeyOf(o.title), duplicate_of: null, reach_metrics: o.reach_metrics ?? null, region: o.region ?? null,
});

describe('signals: freshness, T7', () => {
  it('fresh ≤ 14d, aging ≤ 45d, stale > 45d, undated or future-dated = unknown', () => {
    expect(signalFreshness(NOW - 3 * DAY, NOW)).toBe('fresh');
    expect(signalFreshness(NOW - 30 * DAY, NOW)).toBe('aging');
    expect(signalFreshness(NOW - 46 * DAY, NOW)).toBe('stale');
    expect(signalFreshness(null, NOW)).toBe('unknown');
    expect(signalFreshness(NOW + 5 * DAY, NOW)).toBe('unknown');
  });
  it('a cluster made only of stale items is never live, and its class is computed from live items only', () => {
    const [c] = clusterSignals([sig({ title: 'Keratin trend', topic: 'hair', days: 60, reach_metrics: { views: 1000 } }), sig({ title: 'Keratin again', topic: 'hair', days: 58, source: 's2' })], NOW);
    expect(c).toMatchObject({ liveness: 'stale', live_count: 0, evidence_class: 'example' });
  });
});

describe('signals: dedupe and deterministic clustering', () => {
  it('the same story from several sources has one dedupe key (order and case independent)', () => {
    expect(dedupeKeyOf('Glass skin facials are back!')).toBe(dedupeKeyOf('FACIALS: glass skin are back'));
    expect(dedupeKeyOf('البشرة الزجاجية تعود')).toBe(dedupeKeyOf('بشرة زجاجية تعود'));
    expect(dedupeKeyOf('Nail art')).not.toBe(dedupeKeyOf('Bridal hair'));
  });
  it('relates by topic or title similarity within 14 days; components do not depend on input order', () => {
    const a = sig({ title: 'Balayage colour ideas', topic: 'hair', days: 2 });
    const b = sig({ title: 'Keratin for summer hair', topic: 'hair', days: 9, source: 's2' });
    const c = sig({ title: 'Henna nights', topic: 'henna', days: 3 });
    const d = sig({ title: 'Balayage colour ideas', topic: 'hair', days: 30, source: 's3' }); // same topic but > 14 days from b
    const e = sig({ title: 'Unrelated city news', days: 4 });
    const r1 = clusterSignals([a, b, c, d, e], NOW);
    const r2 = clusterSignals([e, d, c, b, a], NOW);
    expect(r1).toEqual(r2);
    const hair = r1.find((x) => x.signal_ids.includes(a.id))!;
    expect(hair.signal_ids.sort()).toEqual([a.id, b.id].sort());
    expect(r1.find((x) => x.signal_ids.includes(d.id))!.signal_ids).toEqual([d.id]);
    expect(r1).toHaveLength(4);
  });
  it('a syndicated story counts once (stories, not items)', () => {
    const r = clusterSignals([sig({ title: 'Nail trend 2026', topic: 'nails', days: 1 }), sig({ title: 'Nail trend 2026', topic: 'nails', days: 1, source: 's2' })], NOW);
    expect(r[0]).toMatchObject({ signal_count: 1, source_count: 2, live_count: 1, evidence_class: 'example' });
  });
});

describe('signals: evidence classes', () => {
  it('supported_trend only with numbers supplied by the source; early_signal needs ≥3 stories from ≥2 sources', () => {
    expect(evidenceClassOf([{ reach_metrics: { searches: 1200 } }], 1, 1)).toBe('supported_trend');
    expect(evidenceClassOf([{ reach_metrics: null }, { reach_metrics: null }, { reach_metrics: null }], 3, 2)).toBe('early_signal');
    expect(evidenceClassOf([{ reach_metrics: null }, { reach_metrics: null }, { reach_metrics: null }], 3, 1)).toBe('example');
    expect(evidenceClassOf([{ reach_metrics: {} }], 1, 1)).toBe('example');
  });
  it('API items keep only finite, non-negative numbers the provider gave; nothing derived', () => {
    const [x] = parseJsonItems(JSON.stringify({ items: [{ title: 'Lash lift', url: 'https://a.example/x', published_at: '2026-11-01', metrics: { views: 10, growth: 'fast', bad: -1, ok_rate: 0.4 } }] }), 'https://a.example');
    expect(x!.reach_metrics).toEqual({ views: 10, ok_rate: 0.4 });
    const [y] = parseFeed('<rss><item><title>Plain</title><link>http://insecure.example/x</link></item></rss>', 'https://feed.example');
    expect(y).toMatchObject({ reach_metrics: null, url: null, published_at: null });
  });
});

describe('relevance (rules) and P1', () => {
  const rc: RelevanceContext = {
    packId: 'beauty', city: 'الرياض', offerings: [{ id: 'o-hair', name: { ar: 'صبغة شعر', en: 'Hair Colour' } }], awarenessOnlyTopics: beautyPack.validation.awarenessOnlyTopics,
    opportunities: [{ id: 'opp1', category: 'quiet_capacity', offering_ids: ['o-hair'], period: { from: '2026-11-10', to: '2026-11-23' }, action_kind: 'reminder', rank: 1, title: { ar: 'فرصة', en: 'Opp' } }],
  };
  it('scores sector, audience, region and the link to an open internal opportunity with reasons', () => {
    const r = signalRelevance({ topic: 'hair', region: 'Riyadh' }, rc);
    expect(r.factors).toEqual({ sector: 1, audience: 1, region: 1, opportunity: 1 });
    expect(r.score).toBe(1);
    expect(r.opportunity_id).toBe('opp1');
    expect(r.reasons).toHaveLength(4);
    const none = signalRelevance({ topic: 'hair', region: null }, { ...rc, opportunities: [] });
    expect(none.opportunity_id).toBeNull();
    expect(none.reasons.at(-1)!.en).toMatch(/nothing is suggested because of it alone/);
  });
  it('events link only to a promotional open opportunity whose window ends ≤ 30 days before; never to a prerequisite', () => {
    expect(eventRelevance({ kind: 'national', region: 'SA', starts_on: '2026-12-10', topics: [], awareness_only: false }, rc).opportunity_id).toBe('opp1');
    expect(eventRelevance({ kind: 'national', region: 'SA', starts_on: '2027-02-22', topics: [], awareness_only: false }, rc).opportunity_id).toBeNull();
    const pre = { ...rc, opportunities: [{ ...rc.opportunities[0]!, category: 'capacity_prerequisite', action_kind: 'staffing' }] };
    expect(eventRelevance({ kind: 'national', region: 'SA', starts_on: '2026-12-01', topics: [], awareness_only: false }, pre).opportunity_id).toBeNull();
  });
  it('region: Saudi-wide and own city fit; another city does not', () => {
    expect(regionFit('SA', 'Jeddah').fit).toBe(1);
    expect(regionFit('SA:riyadh', 'الرياض').fit).toBe(1);
    expect(regionFit('SA:jeddah', 'Riyadh').fit).toBe(0);
    expect(regionFit(null, 'Riyadh').fit).toBe(0.5);
  });
});

describe('awareness-only health days', () => {
  it('pack topics and health_awareness events are awareness-only', () => {
    expect(isAwarenessOnly({ kind: 'world_day', topics: ['diabetes_day'] }, beautyPack)).toBe(true);
    expect(isAwarenessOnly({ kind: 'health_awareness', topics: [] }, beautyPack)).toBe(true);
    expect(isAwarenessOnly({ kind: 'national', topics: [] }, beautyPack)).toBe(false);
  });
  it('validator rule: no direct discount coupling and no therapeutic claims', () => {
    expect(checkAwarenessRule({ awareness_only: true, text: 'نصائح للعناية بالبشرة', framing: 'awareness_only' }, beautyPack).ok).toBe(true);
    expect(checkAwarenessRule({ awareness_only: true, text: 'خصم 20% بمناسبة يوم السكري' }, beautyPack).violations).toEqual(['discount_coupling']);
    expect(checkAwarenessRule({ awareness_only: true, text: { ar: 'جلسة', en: 'Session' }, discount_bp: 1000 }).violations).toEqual(['discount_coupling']);
    expect(checkAwarenessRule({ awareness_only: true, text: 'This facial treats diabetes skin' }, beautyPack).violations).toEqual(['therapeutic_claim']);
    expect(checkAwarenessRule({ awareness_only: true, text: 'معلومة', framing: 'standard' }).violations).toEqual(['missing_awareness_framing']);
    expect(checkAwarenessRule({ awareness_only: false, text: 'خصم 50%' }).ok).toBe(true);
  });
});

describe('starter calendar and ICS import', () => {
  it('every entry is attributed; lunar estimates and approximate dates always need verification', () => {
    for (const e of SA_STARTER_CALENDAR) {
      expect(e.source_name.length, e.key).toBeGreaterThan(5);
      if (e.date_basis !== 'fixed_gregorian') expect(e.needs_verification, e.key).toBe(true);
      expect(e.starts_on <= e.ends_on).toBe(true);
      expect(e.starts_on >= '2026-11-01' && e.starts_on <= '2027-11-30').toBe(true);
    }
    expect(SA_STARTER_CALENDAR.find((e) => e.key.includes('eid_al_fitr'))!.needs_verification).toBe(true);
    expect(SA_STARTER_CALENDAR.find((e) => e.key.includes('national_day'))).toMatchObject({ starts_on: '2027-09-23', needs_verification: false });
  });
  it('parses all-day VEVENTs with exclusive DTEND and folded lines', () => {
    const ics = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:a1\r\nDTSTART;VALUE=DATE:20270222\r\nDTEND;VALUE=DATE:20270223\r\nSUMMARY:Founding\r\n  Day\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nDTSTART:20270923T000000Z\r\nSUMMARY:<b>National</b> Day\r\nEND:VEVENT\r\nEND:VCALENDAR';
    expect(parseIcs(ics)).toEqual([
      { uid: 'a1', untrusted_title: 'Founding Day', untrusted_description: null, starts_on: '2027-02-22', ends_on: '2027-02-22', region: null, kind: null },
      { uid: null, untrusted_title: 'National Day', untrusted_description: null, starts_on: '2027-09-23', ends_on: '2027-09-23', region: null, kind: null },
    ]);
  });
});

describe('T15: competitor prices are context only', () => {
  it('price context never allows a decrease; non-comparable prices are ignored', () => {
    const pc = marketPriceContext('o1', 30000, [
      { offering_id: 'o1', price_minor: 15000, comparability: 'comparable', kind: 'price_point' },
      { offering_id: 'o1', price_minor: 1000, comparability: 'not_comparable', kind: 'price_point' },
    ]);
    expect(pc).toMatchObject({ position: 'above_market', comparable_prices: 1, median_comparable_minor: 15000, may_decrease_price: false });
    expect(priceProposalAllowed(30000, 20000)).toEqual({ allowed: false, reason: 'price_decrease_not_supported' });
    expect(priceProposalAllowed(30000, 33000).allowed).toBe(true);
  });
  it('the engine guard strips price cuts, keeps increase reviews and cost reviews, and notes market context', () => {
    const mk = (fp: string, action: Record<string, unknown>): AssessedOpportunity => ({ fingerprint: fp, subject: { offering_ids: ['o1'], key: 'k' }, card: { recommended_action: action, limitations: [] } } as unknown as AssessedOpportunity);
    const g = enforceNoMarketPriceCut([
      mk('cut', { kind: 'price_review', intervention_id: 'price_review', direction: null }),
      mk('cut2', { kind: 'price_review', intervention_id: 'price_review', direction: 'decrease' }),
      mk('up', { kind: 'price_review', intervention_id: 'price_review', direction: 'increase_review' }),
      mk('cost', { kind: 'price_review', intervention_id: 'cost_review', direction: null }),
    ], new Set(['o1']));
    expect(g.removed.map((r) => r.fingerprint)).toEqual(['cut', 'cut2']);
    expect(g.kept.map((o) => o.fingerprint)).toEqual(['up', 'cost']);
    expect(g.kept[0]!.card.limitations[0]!.en).toMatch(/context only/);
  });
});

import { L, type Localized } from '../util/text';
import { addDays } from '../util/time';
import { normalizeText } from './signals';
import { offeringsForTopic, SECTOR_TOPICS } from './topics';
import type { Relevance } from './types';

/**
 * Rules-first relevance (§12.2). No model is involved. Four factors, each in
 * [0, 1], weighted: sector .35, audience .25, region .15, link to an OPEN
 * internal opportunity .25. Every point comes with a reason. The opportunity
 * link is a suggestion; attaching is an explicit owner action, and an
 * external item never creates an opportunity by itself (P1, T8).
 */
export const RELEVANCE_WEIGHTS = { sector: 0.35, audience: 0.25, region: 0.15, opportunity: 0.25 } as const;

export type OpenOpportunity = { id: string; category: string; offering_ids: string[]; period: { from: string; to: string }; action_kind: string; rank: number | null; title: Localized };
export type RelevanceContext = { packId: string; city: string | null; offerings: Array<{ id: string; name: Localized }>; opportunities: OpenOpportunity[]; awarenessOnlyTopics: string[] };

/** Opportunities an external item may time (promotional ones that are not a prerequisite step). */
const TIMEABLE_ACTIONS = new Set(['content', 'package', 'value_add', 'reminder', 'loyalty', 'limited_discount']);
export const isTimeable = (o: Pick<OpenOpportunity, 'category' | 'action_kind'>) => o.category !== 'capacity_prerequisite' && TIMEABLE_ACTIONS.has(o.action_kind);

const CITIES: Record<string, string[]> = {
  riyadh: ['riyadh', 'الرياض'], jeddah: ['jeddah', 'jiddah', 'جدة', 'جده'], makkah: ['makkah', 'mecca', 'مكة'], madinah: ['madinah', 'medina', 'المدينة'],
  dammam: ['dammam', 'الدمام'], khobar: ['khobar', 'الخبر'], dhahran: ['dhahran', 'الظهران'], al_ahsa: ['ahsa', 'hofuf', 'الأحساء', 'الهفوف'],
  taif: ['taif', 'الطائف'], abha: ['abha', 'أبها'], tabuk: ['tabuk', 'تبوك'], buraydah: ['buraydah', 'qassim', 'بريدة', 'القصيم'], hail: ['hail', 'حائل'],
  jazan: ['jazan', 'jizan', 'جازان'], najran: ['najran', 'نجران'], al_ula: ['alula', 'al ula', 'العلا'],
};
export function cityCode(city: string | null): string | null {
  if (!city) return null;
  const c = normalizeText(city);
  for (const [code, names] of Object.entries(CITIES)) if (names.some((n) => c.includes(normalizeText(n)))) return code;
  return null;
}

/** Region fit: 1 = applies to the business's area, 0.5 = unknown/global, 0 = another local area. */
export function regionFit(region: string | null, city: string | null): { fit: number; reason: Localized } {
  if (!region || region === 'GLOBAL') return { fit: 0.5, reason: L('النطاق الجغرافي عام أو غير محدد.', 'The geographic scope is global or not stated.') };
  const r = region.trim();
  if (/^(SA|KSA|saudi|saudi arabia|السعودية|المملكة)$/i.test(r)) return { fit: 1, reason: L('على مستوى المملكة.', 'Saudi-wide.') };
  const code = r.startsWith('SA:') ? r.slice(3) : cityCode(r);
  const mine = cityCode(city);
  if (code && mine && code === mine) return { fit: 1, reason: L('في مدينة نشاطك.', 'In your city.') };
  if (code && mine) return { fit: 0, reason: L('خاص بمنطقة أخرى غير مدينتك.', 'Specific to another area than your city.') };
  return { fit: 0.5, reason: L('لا يمكن مطابقة المنطقة مع مدينة نشاطك.', 'The region cannot be matched with your city.') };
}

const finish = (f: Relevance['factors'], reasons: Localized[], offering_ids: string[], opportunity_id: string | null): Relevance => ({
  score: Math.round((f.sector * RELEVANCE_WEIGHTS.sector + f.audience * RELEVANCE_WEIGHTS.audience + f.region * RELEVANCE_WEIGHTS.region + f.opportunity * RELEVANCE_WEIGHTS.opportunity) * 1000) / 1000,
  factors: f, reasons, offering_ids, opportunity_id,
});

const byRank = (a: OpenOpportunity, b: OpenOpportunity) => (a.rank ?? 1e9) - (b.rank ?? 1e9) || a.id.localeCompare(b.id);

/** Relevance of a (live) signal cluster. */
export function signalRelevance(item: { topic: string | null; region: string | null }, c: RelevanceContext): Relevance {
  const reasons: Localized[] = [];
  const sector = item.topic && SECTOR_TOPICS[c.packId]?.[item.topic] ? 1 : 0;
  reasons.push(sector ? L(`الموضوع «${item.topic}» من موضوعات قطاعك.`, `The topic “${item.topic}” belongs to your sector.`) : L('لا يرتبط الموضوع بقطاعك بوضوح.', 'The topic is not clearly related to your sector.'));
  const offering_ids = offeringsForTopic(item.topic, c.packId, c.offerings);
  const audience = offering_ids.length ? 1 : 0;
  reasons.push(audience ? L(`يطابق ${offering_ids.length} من خدماتك أو منتجاتك النشطة.`, `Matches ${offering_ids.length} of your active offerings.`) : L('لا توجد خدمة نشطة مرتبطة بالموضوع.', 'No active offering relates to the topic.'));
  const rf = regionFit(item.region, c.city);
  reasons.push(rf.reason);
  const linked = c.opportunities.filter((o) => isTimeable(o) && o.offering_ids.some((id) => offering_ids.includes(id))).sort(byRank)[0] ?? null;
  reasons.push(linked ? L(`يرتبط بفرصة داخلية مفتوحة: «${linked.title.ar}».`, `Relates to an open internal opportunity: “${linked.title.en}”.`)
    : L('لا توجد فرصة داخلية مفتوحة مرتبطة؛ لا يُقترح شيء بسببه وحده.', 'No open internal opportunity relates to it; nothing is suggested because of it alone.'));
  return finish({ sector, audience, region: rf.fit, opportunity: linked ? 1 : 0 }, reasons, offering_ids, linked?.id ?? null);
}

const KIND_SECTOR: Record<string, number> = { national: 0.7, religious: 0.7, commercial: 0.7, school_holiday: 0.5, local_event: 0.5, world_day: 0.4, health_awareness: 0.6 };

/** Relevance of a calendar event: the opportunity factor is a promotional open opportunity whose window ends ≤ 30 days before the event. */
export function eventRelevance(ev: { kind: string; region: string | null; starts_on: string; topics: string[]; awareness_only: boolean }, c: RelevanceContext): Relevance {
  const reasons: Localized[] = [];
  const packTopic = ev.topics.some((t) => c.awarenessOnlyTopics.includes(t));
  const sector = packTopic ? 1 : KIND_SECTOR[ev.kind] ?? 0.4;
  reasons.push(packTopic ? L('مناسبة صحية تحددها حزمة قطاعك (توعوية فقط).', 'A health day listed by your sector pack (awareness only).') : L('مناسبة عامة تؤثر في توقيت الحجز والشراء.', 'A general occasion that affects when people book and buy.'));
  const audience = c.offerings.length ? 0.5 : 0;
  reasons.push(L('تخص عموم العميلات وليست خدمة بعينها.', 'It concerns customers in general, not a specific offering.'));
  const rf = regionFit(ev.region, c.city);
  reasons.push(rf.reason);
  const linked = c.opportunities.filter((o) => isTimeable(o) && o.period.from <= ev.starts_on && addDays(o.period.to, 30) >= ev.starts_on)
    .filter((o) => !(ev.awareness_only && o.action_kind === 'limited_discount')).sort(byRank)[0] ?? null;
  reasons.push(linked ? L(`يمكن أن يحدد توقيت فرصة داخلية مفتوحة: «${linked.title.ar}».`, `Can set the timing of an open internal opportunity: “${linked.title.en}”.`)
    : L('لا توجد فرصة داخلية مفتوحة في نافذتها؛ لا تُنشأ حملة بسبب المناسبة وحدها.', 'No open internal opportunity falls in its window; no campaign is created for the event alone.'));
  return finish({ sector, audience, region: rf.fit, opportunity: linked ? 1 : 0 }, reasons, [], linked?.id ?? null);
}

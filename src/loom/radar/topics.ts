import type { SectorPack } from '../sector/types';
import { normalizeText } from './signals';

/**
 * Topic vocabulary per sector pack (keyword → topic). The first keyword of a
 * topic is also the one matched against offering names (audience fit).
 */
export const SECTOR_TOPICS: Record<string, Record<string, string[]>> = {
  beauty: {
    hair: ['hair', 'balayage', 'keratin', 'haircut', 'blowout', 'شعر', 'كيراتين', 'صبغة', 'بالياج', 'تسريحة', 'colour', 'color'],
    nails: ['nail', 'manicure', 'pedicure', 'أظافر', 'مانيكير', 'باديكير'],
    skin: ['skin', 'facial', 'serum', 'skincare', 'بشرة', 'تنظيف البشرة', 'سيروم', 'glow'],
    makeup: ['makeup', 'make-up', 'مكياج', 'ميك اب'],
    lashes_brows: ['lash', 'brow', 'رموش', 'حواجب'],
    bridal: ['bride', 'bridal', 'wedding', 'عروس', 'عرائس', 'زفاف'],
    spa: ['spa', 'massage', 'سبا', 'مساج', 'حمام مغربي'],
    henna: ['henna', 'حناء', 'حنة'],
    hair_removal: ['laser', 'waxing', 'ليزر', 'شمع', 'إزالة الشعر'],
  },
};

/** Health-awareness topics recognised in calendar titles (the sector pack decides which are awareness-only). */
export const HEALTH_TOPICS: Record<string, string[]> = {
  breast_cancer_awareness: ['breast cancer', 'سرطان الثدي', 'pink october', 'أكتوبر الوردي'],
  world_health_day: ['world health day', 'يوم الصحة العالمي'],
  diabetes_day: ['diabetes', 'سكري'],
  world_cancer_day: ['world cancer day', 'اليوم العالمي للسرطان'],
  mental_health_day: ['mental health', 'صحة النفسية'],
};

const has = (text: string, kw: string) => normalizeText(text).includes(normalizeText(kw));

export function detectTopic(text: string, packId: string): string | null {
  for (const [topic, kws] of Object.entries(SECTOR_TOPICS[packId] ?? {})) if (kws.some((k) => has(text, k))) return topic;
  return null;
}

export function detectHealthTopics(text: string): string[] {
  return Object.entries(HEALTH_TOPICS).filter(([, kws]) => kws.some((k) => has(text, k))).map(([t]) => t);
}

/** Offerings whose name mentions the topic (audience fit). */
export function offeringsForTopic(topic: string | null, packId: string, offerings: Array<{ id: string; name: { ar: string; en: string } }>): string[] {
  if (!topic) return [];
  const kws = SECTOR_TOPICS[packId]?.[topic] ?? [];
  return offerings.filter((o) => kws.some((k) => has(`${o.name.ar} ${o.name.en}`, k))).map((o) => o.id);
}

/**
 * An event is awareness-only when it is a health-awareness event or carries a
 * topic the sector pack lists in validation.awarenessOnlyTopics.
 */
export function isAwarenessOnly(ev: { kind: string; topics?: string[] | null }, pack: Pick<SectorPack, 'validation'>): boolean {
  return ev.kind === 'health_awareness' || (ev.topics ?? []).some((t) => pack.validation.awarenessOnlyTopics.includes(t));
}

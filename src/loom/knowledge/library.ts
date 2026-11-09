import { z } from 'zod';
import { CHANNELS } from '../contracts/opportunity';
import { stableHash, type Localized } from '../util/text';
import { RAW_UNITS } from './units';

/**
 * Marketing knowledge (§9): curated playbook units with sector scope, source
 * and review date. Code (the JSON files) is the source of truth; units are
 * mirrored insert-only into loom.knowledge_units by (id, version).
 */
const loc = z.object({ ar: z.string().min(1), en: z.string().min(1) }).strict();
export const knowledgeUnitSchema = z.object({
  id: z.string().regex(/^pb\.[a-z0-9_.]{3,80}$/),
  version: z.number().int().min(1),
  title: loc,
  applies_to: z.object({
    sectors: z.array(z.string().min(1)).min(1),
    detectors: z.array(z.string()),
    interventions: z.array(z.string()),
    channels: z.array(z.enum(CHANNELS)),
  }).strict(),
  guidance: loc,
  when_not_to_use: loc,
  common_mistakes: z.array(loc),
  measurement: z.object({ primary: z.string().min(1), design: z.enum(['holdout', 'ab', 'pre_post_with_control', 'observational']), note: loc.optional() }).strict(),
  examples: z.object({ good: z.array(loc).min(1), bad: z.array(loc).min(1) }).strict(),
  source: z.object({ type: z.enum(['internal_review', 'publication']), ref: z.string().min(1), reviewed_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict(),
  owner: z.string().min(1),
}).strict();
export type KnowledgeUnit = z.infer<typeof knowledgeUnitSchema>;

let parsed: KnowledgeUnit[] | null = null;
/** The parsed library (throws on an invalid unit: a broken file must fail tests, not production retrieval). */
export function knowledgeLibrary(): KnowledgeUnit[] {
  if (!parsed) {
    parsed = RAW_UNITS.map((u) => knowledgeUnitSchema.parse(u));
    const ids = new Set<string>();
    for (const u of parsed) { if (ids.has(u.id)) throw new Error(`duplicate knowledge unit ${u.id}`); ids.add(u.id); }
  }
  return parsed;
}
export const unitHash = (u: KnowledgeUnit) => stableHash(u);

export type KnowledgeQuery = { sector: string; detector?: string | null; intervention?: string | null; channels?: string[]; text?: string; limit?: number };
export type RetrievedUnit = { unit: KnowledgeUnit; score: number; stale: boolean };

const TOKEN = /[\p{L}\p{N}_]{3,}/gu;
const tokens = (s: string) => new Set((s.toLowerCase().match(TOKEN) ?? []));

/** A unit older than 12 months is flagged for review (never deleted, §9). */
export function isStale(u: KnowledgeUnit, today: string) {
  const d = new Date(`${u.source.reviewed_at}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 12);
  return d.toISOString().slice(0, 10) < today;
}

/**
 * Retrieval: (1) HARD filter — sector must match, and the detector (or the
 * intervention) must be in the unit's scope; nothing outside the sector is
 * ever returned however similar the words. (2) Simple lexical ranking inside
 * the candidates (intervention match, channel overlap, token overlap).
 */
export function rankUnits(units: KnowledgeUnit[], q: KnowledgeQuery, today: string): RetrievedUnit[] {
  const qTokens = tokens(q.text ?? '');
  const out: RetrievedUnit[] = [];
  for (const u of units) {
    if (!u.applies_to.sectors.includes(q.sector)) continue;
    const detOk = q.detector ? u.applies_to.detectors.includes(q.detector) : true;
    const intOk = q.intervention ? u.applies_to.interventions.includes(q.intervention) : false;
    if (!detOk && !intOk) continue;
    let score = 0;
    if (intOk) score += 3;
    if (detOk && q.detector) score += 1;
    if (q.channels?.length) score += u.applies_to.channels.filter((c) => q.channels!.includes(c)).length * 0.25;
    if (qTokens.size) {
      const ut = tokens(`${u.title.ar} ${u.title.en} ${u.guidance.ar} ${u.guidance.en}`);
      let hit = 0;
      for (const t of qTokens) if (ut.has(t)) hit++;
      score += hit / qTokens.size;
    }
    // Generic units (scoped to every detector) rank after the specific ones.
    if (u.applies_to.detectors.length > 6) score -= 0.5;
    out.push({ unit: u, score, stale: isStale(u, today) });
  }
  return out.sort((a, b) => b.score - a.score || a.unit.id.localeCompare(b.unit.id)).slice(0, q.limit ?? 3);
}

/** Compact snippet given to the planner (no business data). */
export function snippet(u: KnowledgeUnit) {
  return {
    ref: `${u.id}@${u.version}`, title: u.title, guidance: u.guidance, when_not_to_use: u.when_not_to_use,
    measurement: { primary: u.measurement.primary, design: u.measurement.design }, good_example: u.examples.good[0]!, bad_example: u.examples.bad[0]!,
  };
}

export const knowledgeRef = (u: Pick<KnowledgeUnit, 'id' | 'version'>) => `${u.id}@${u.version}`;
export function parseKnowledgeRef(ref: string): { id: string; version: number } | null {
  const m = /^(pb\.[a-z0-9_.]{3,80})@(\d+)$/.exec(ref);
  return m ? { id: m[1]!, version: Number(m[2]) } : null;
}
export type { Localized };

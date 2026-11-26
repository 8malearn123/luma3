import { createHash } from 'node:crypto';
import type { EvidenceClass, Freshness } from './types';

/**
 * Pure signal rules (§12.1): normalisation, freshness, dedupe keys,
 * deterministic clustering and evidence classes. No I/O.
 *
 * Freshness (by the source's own published date): fresh ≤ 14 days, aging
 * ≤ 45 days, stale > 45 days, unknown when undated (or dated in the future).
 * Only fresh/aging signals are LIVE (T7): stale or undated items are shown
 * as such and never feed a live cluster, relevance or an attachment.
 */
export const DAY = 86_400_000;
export const FRESH_DAYS = 14;
export const LIVE_DAYS = 45;
/** Items older than this are not stored at all. */
export const MAX_AGE_DAYS = 180;
/** Two signals are only related when published within this many days of each other. */
export const CLUSTER_WINDOW_DAYS = 14;
/** Title-token Jaccard similarity that relates two signals without a shared topic. */
export const CLUSTER_JACCARD = 0.5;

export function freshnessOf(published: number | null, now: number): Freshness {
  if (published == null || published > now + DAY) return 'unknown';
  const days = (now - published) / DAY;
  return days <= FRESH_DAYS ? 'fresh' : days <= LIVE_DAYS ? 'aging' : 'stale';
}
export const isLive = (f: Freshness) => f === 'fresh' || f === 'aging';
export const validUntilOf = (published: number | null) => (published == null ? null : new Date(published + LIVE_DAYS * DAY).toISOString().slice(0, 10));

const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'this', 'that', 'your', 'you', 'are', 'how', 'what', 'new', 'best', 'top', 'into', 'about', 'will', 'more',
  'في', 'من', 'على', 'الى', 'إلى', 'عن', 'مع', 'هذا', 'هذه', 'التي', 'الذي', 'كيف', 'ما', 'او', 'أو', 'ثم', 'كل', 'بعد', 'قبل', 'عند', 'اكثر', 'أكثر', 'افضل', 'أفضل']);

/** Arabic-aware normalisation: lower-case, no diacritics/tatweel, unified alef/yaa/taa marbuta. */
export function normalizeText(s: string) {
  return s.toLowerCase().normalize('NFKC').replace(/[ً-ٰٟـ]/g, '').replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه');
}

/** Sorted unique content tokens of a title (≥ 3 letters, stop-words and the Arabic article removed). */
export function titleTokens(title: string): string[] {
  const out = new Set<string>();
  for (let w of normalizeText(title).split(/[^\p{L}\p{N}]+/u)) {
    if (!w || STOP.has(w)) continue;
    if (/^ال[\p{L}]{3,}$/u.test(w)) w = w.slice(2);
    if (w.length >= 3 && !STOP.has(w)) out.add(w);
  }
  return [...out].sort().slice(0, 30);
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
/** Same story across sources ⇒ same dedupe key (order-independent title tokens). */
export const dedupeKeyOf = (title: string) => sha(titleTokens(title).join(' ') || normalizeText(title).trim());
/** Per-source identity of an item (a user link is identified by its page). */
export const contentHashOf = (title: string, kind: string, url: string) => sha(kind === 'user_link' ? `${normalizeText(title).trim()}|${url}` : normalizeText(title).trim());

export function jaccard(a: string[], b: string[]) {
  if (!a.length || !b.length) return 0;
  const sa = new Set(a);
  let inter = 0;
  for (const x of b) if (sa.has(x)) inter++;
  return inter / (sa.size + new Set(b).size - inter);
}

export type ClusterInput = {
  id: string; source_id: string; topic: string | null; tokens: string[]; published_at: number | null; observed_at: number;
  dedupe_key: string; duplicate_of: string | null; reach_metrics: Record<string, number> | null; untrusted_title: string; region: string | null;
};
export type ClusterResult = {
  cluster_key: string; topic: string | null; untrusted_label: string; signal_ids: string[]; signal_count: number; source_count: number; live_count: number;
  evidence_class: EvidenceClass; liveness: 'live' | 'stale'; first_published_at: number | null; last_published_at: number | null; valid_until: string | null; region: string | null;
};

/**
 * Deterministic clustering. Two signals are RELATED when their reference
 * times (published, else observed) are within CLUSTER_WINDOW_DAYS and they
 * share a topic, or their title tokens have Jaccard ≥ CLUSTER_JACCARD, or they
 * are the same story (dedupe key). Clusters are the connected components of
 * that relation, so the result does not depend on input order. The cluster
 * key is derived from its earliest member (time, then id), so it is stable
 * while the cluster grows.
 */
export function clusterSignals(input: ClusterInput[], now: number): ClusterResult[] {
  const xs = [...input].sort((a, b) => (a.published_at ?? a.observed_at) - (b.published_at ?? b.observed_at) || a.id.localeCompare(b.id));
  const parent = xs.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const tOf = (s: ClusterInput) => s.published_at ?? s.observed_at;
  for (let i = 0; i < xs.length; i++) {
    for (let j = i + 1; j < xs.length; j++) {
      const a = xs[i]!, b = xs[j]!;
      if (tOf(b) - tOf(a) > CLUSTER_WINDOW_DAYS * DAY) break;
      const related = a.dedupe_key === b.dedupe_key || (!!a.topic && a.topic === b.topic) || jaccard(a.tokens, b.tokens) >= CLUSTER_JACCARD;
      if (related) { const ra = find(i), rb = find(j); if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb); }
    }
  }
  const groups = new Map<number, ClusterInput[]>();
  xs.forEach((s, i) => { const r = find(i); groups.set(r, [...(groups.get(r) ?? []), s]); });
  const out: ClusterResult[] = [];
  for (const members of groups.values()) {
    const anchor = members[0]!;
    // A story syndicated by several sources counts once.
    const stories = new Map<string, ClusterInput[]>();
    for (const m of members) stories.set(m.dedupe_key, [...(stories.get(m.dedupe_key) ?? []), m]);
    const live = members.filter((m) => isLive(freshnessOf(m.published_at, now)));
    const liveStories = new Set(live.map((m) => m.dedupe_key));
    const liveSources = new Set(live.map((m) => m.source_id));
    const dated = members.filter((m) => m.published_at != null).map((m) => m.published_at!);
    const topics = members.map((m) => m.topic).filter((t): t is string => !!t);
    const topic = topics.length ? [...topics].sort((a, b) => topics.filter((t) => t === b).length - topics.filter((t) => t === a).length || a.localeCompare(b))[0]! : null;
    const label = [...(live.length ? live : members)].sort((a, b) => tOf(b) - tOf(a) || a.id.localeCompare(b.id))[0]!.untrusted_title;
    const validDates = (live.length ? live : members).map((m) => validUntilOf(m.published_at)).filter((d): d is string => !!d).sort();
    const regions = [...new Set(members.map((m) => m.region).filter((r): r is string => !!r))];
    out.push({
      cluster_key: `c_${sha(anchor.dedupe_key).slice(0, 24)}`, topic, untrusted_label: label,
      signal_ids: members.map((m) => m.id), signal_count: stories.size, source_count: new Set(members.map((m) => m.source_id)).size, live_count: liveStories.size,
      evidence_class: evidenceClassOf(live, liveStories.size, liveSources.size), liveness: live.length ? 'live' : 'stale',
      first_published_at: dated.length ? Math.min(...dated) : null, last_published_at: dated.length ? Math.max(...dated) : null,
      valid_until: validDates.at(-1) ?? null, region: regions.length === 1 ? regions[0]! : null,
    });
  }
  return out.sort((a, b) => a.cluster_key.localeCompare(b.cluster_key));
}

/**
 * Evidence class of a cluster, from its LIVE members only:
 *  supported_trend — at least one live item carries numbers supplied by the source itself;
 *  early_signal    — ≥ 3 distinct live stories from ≥ 2 sources;
 *  example         — anything else (a single or repeated example).
 * Counts or growth rates are never estimated.
 */
export function evidenceClassOf(live: Array<Pick<ClusterInput, 'reach_metrics'>>, stories: number, sources: number): EvidenceClass {
  if (live.some((m) => m.reach_metrics && Object.keys(m.reach_metrics).length > 0)) return 'supported_trend';
  if (stories >= 3 && sources >= 2) return 'early_signal';
  return 'example';
}
/** Evidence class of a single stored signal. */
export const signalEvidenceClass = (m: Record<string, number> | null): EvidenceClass => (m && Object.keys(m).length ? 'supported_trend' : 'example');

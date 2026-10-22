import { createHash } from 'node:crypto';
import type { z } from 'zod';
import { sql, withTenant, type Tx } from '../../db/client';
import { Errors } from '../../http/errors';
import { audit, type AuditActor } from '../../infra/audit';
import type { TenantAccess } from '../../tenancy/access';
import { computeOccupancy } from '../analytics/occupancy';
import { addDays, localToday } from '../analytics/period';
import type { PlanContent, trendSourceInput } from '@/shared/schemas/marketing';
import { appendVersion } from './plans';
import { checkUrl, defaultResolver, isBlockedIp, safeFetch, SafeFetchError, type SafeFetchOptions } from './safe-fetch';
import { freshnessOf } from './snapshot';

/**
 * Trend radar (§30). Model memory is never treated as news: only permitted
 * sources (RSS feeds, user-provided links) are read, through the SSRF-safe
 * fetcher. Each observation keeps source, URL, published/observed time and only
 * the metrics the source provides (RSS provides none). Evidence strength:
 *   anecdotal    — single or undated observations;
 *   early_signal — ≥3 fresh (≤30 days) dated observations from ≥2 sources;
 *   quantified   — only when a source supplies real metrics.
 * Stale (>45 days), undated and duplicate items never become a live trend.
 */

let fetchOverride: SafeFetchOptions | undefined;
/** Tests inject a fake transport/resolver; production uses the real network. */
export function setTrendFetchForTests(o: SafeFetchOptions | undefined) { fetchOverride = o; }

const TOPICS: Record<string, string[]> = {
  hair: ['hair', 'balayage', 'keratin', 'haircut', 'blowout', 'شعر', 'كيراتين', 'صبغة', 'بالياج', 'تسريحة'],
  nails: ['nail', 'manicure', 'pedicure', 'أظافر', 'مانيكير', 'باديكير'],
  skin: ['skin', 'facial', 'serum', 'skincare', 'بشرة', 'تنظيف البشرة', 'سيروم'],
  makeup: ['makeup', 'make-up', 'مكياج', 'ميك اب'],
  lashes_brows: ['lash', 'brow', 'رموش', 'حواجب'],
  bridal: ['bride', 'bridal', 'wedding', 'عروس', 'عرائس', 'زفاف'],
  spa: ['spa', 'massage', 'سبا', 'مساج', 'حمام مغربي'],
  henna: ['henna', 'حناء', 'حنة'],
  hair_removal: ['laser', 'waxing', 'ليزر', 'شمع', 'إزالة الشعر'],
};

function detectTopic(text: string): { topic: string; keyword: string } | null {
  const t = text.toLowerCase();
  for (const [topic, kws] of Object.entries(TOPICS)) for (const k of kws) if (t.includes(k.toLowerCase())) return { topic, keyword: TOPICS[topic]![0]! };
  return null;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export function decodeEntities(s: string) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') { const n = e[1]?.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ''; }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}
const clean = (s: string | undefined | null, max: number) => {
  if (!s) return null;
  const t = decodeEntities(s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, max) : null;
};
const tag = (block: string, name: string) => new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(block)?.[1];
const attr = (block: string, el: string, a: string) => new RegExp(`<${el}\\b[^>]*\\b${a}=["']([^"']+)["']`, 'i').exec(block)?.[1];

export type ParsedItem = { title: string; link: string | null; published: Date | null; summary: string | null };

export function parseFeed(xml: string): ParsedItem[] {
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) ?? [];
  return blocks.slice(0, 50).flatMap((b) => {
    const title = clean(tag(b, 'title'), 300);
    if (!title) return [];
    const link = clean(tag(b, 'link'), 500) ?? attr(b, 'link', 'href') ?? null;
    const dateRaw = clean(tag(b, 'pubDate') ?? tag(b, 'published') ?? tag(b, 'updated') ?? tag(b, 'dc:date'), 60);
    const d = dateRaw ? new Date(dateRaw) : null;
    return [{ title, link, published: d && Number.isFinite(d.getTime()) ? d : null, summary: clean(tag(b, 'description') ?? tag(b, 'summary') ?? tag(b, 'content'), 600) }];
  });
}

export function parseHtml(html: string): ParsedItem[] {
  const title = clean(attr(html, 'meta property="og:title"', 'content') ?? tag(html, 'title'), 300);
  if (!title) return [];
  const desc = /<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]*content=["']([^"']*)["']/i.exec(html)?.[1];
  const pub = /<meta[^>]+(?:property|name)=["'](?:article:published_time|date|pubdate)["'][^>]*content=["']([^"']+)["']/i.exec(html)?.[1];
  const d = pub ? new Date(pub) : null;
  return [{ title, link: null, published: d && Number.isFinite(d.getTime()) ? d : null, summary: clean(desc, 600) }];
}

const normTitle = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const hash = (s: string) => createHash('sha256').update(s).digest('hex');

async function assertPublicUrl(raw: string) {
  try {
    const u = checkUrl(raw);
    const resolver = fetchOverride?.resolver ?? defaultResolver;
    const addrs = await resolver(u.hostname.replace(/^\[|\]$/g, '')).catch(() => [] as string[]);
    if (addrs.some((a) => isBlockedIp(a))) throw new SafeFetchError('blocked_address');
  } catch (e) {
    if (e instanceof SafeFetchError) throw Errors.invalid('blocked_url', 'This address cannot be used as a source', { reason: e.code });
    throw e;
  }
}

export async function listSources(access: TenantAccess) {
  return withTenant(access.tenantId, (trx) => trx.selectFrom('trend_sources').selectAll().where('tenant_id', '=', access.tenantId).orderBy('created_at', 'desc').execute());
}

export async function addSource(access: TenantAccess, actor: AuditActor, input: z.infer<typeof trendSourceInput>) {
  await assertPublicUrl(input.url);
  const src = await withTenant(access.tenantId, async (trx) => {
    const n = await trx.selectFrom('trend_sources').select(sql<number>`count(*)::int`.as('n')).where('tenant_id', '=', access.tenantId).executeTakeFirstOrThrow();
    if (n.n >= 20) throw Errors.invalid('too_many_sources', 'Up to 20 sources per business');
    const row = await trx.insertInto('trend_sources').values({ tenant_id: access.tenantId, kind: input.kind, name: input.name, url: input.url, access_basis: input.access_basis, created_by: actor.userId })
      .returningAll().executeTakeFirstOrThrow();
    await audit(trx, actor, 'marketing.trend_source_added', { tenantId: access.tenantId, targetType: 'trend_source', targetId: row.id, data: { kind: input.kind, url: input.url } });
    return row;
  });
  const fetched = await fetchSource(access.tenantId, src.id);
  return { source: src, fetch: fetched };
}

export async function updateSource(access: TenantAccess, actor: AuditActor, id: string, status: 'active' | 'disabled') {
  return withTenant(access.tenantId, async (trx) => {
    const r = await trx.updateTable('trend_sources').set({ status }).where('id', '=', id).where('tenant_id', '=', access.tenantId).returningAll().executeTakeFirst();
    if (!r) throw Errors.notFound('source');
    await audit(trx, actor, 'marketing.trend_source_updated', { tenantId: access.tenantId, targetType: 'trend_source', targetId: id, data: { status } });
    return r;
  });
}

/** Fetches one source through the SSRF-safe fetcher and stores new, deduplicated observations. */
export async function fetchSource(tenantId: string, sourceId: string, now = new Date()) {
  const src = await withTenant(tenantId, (trx) => trx.selectFrom('trend_sources').selectAll().where('id', '=', sourceId).where('tenant_id', '=', tenantId).executeTakeFirst());
  if (!src) throw Errors.notFound('source');
  if (src.status === 'disabled') return { ok: false, error: 'source_disabled', stored: 0, duplicates: 0, stale_skipped: 0 };
  let items: ParsedItem[];
  try {
    const res = await safeFetch(src.url, fetchOverride);
    items = /html/i.test(res.contentType) ? parseHtml(res.text) : parseFeed(res.text);
  } catch (e) {
    const code = e instanceof SafeFetchError ? e.code : 'network_error';
    await withTenant(tenantId, (trx) => trx.updateTable('trend_sources').set({ status: 'error', last_error: code, last_fetched_at: now }).where('id', '=', sourceId).execute());
    return { ok: false, error: code, stored: 0, duplicates: 0, stale_skipped: 0 };
  }
  let stored = 0, duplicates = 0, stale = 0;
  await withTenant(tenantId, async (trx) => {
    for (const it of items) {
      const published = it.published && it.published.getTime() <= now.getTime() + 86_400_000 ? it.published : null;
      if (published && now.getTime() - published.getTime() > 180 * 86_400_000) { stale++; continue; }
      let link: string | null = null;
      if (it.link) { try { const u = new URL(it.link, src.url); link = u.protocol === 'https:' ? u.toString() : null; } catch { link = null; } }
      const topic = detectTopic(`${it.title} ${it.summary ?? ''}`);
      const r = await trx.insertInto('trend_observations').values({
        tenant_id: tenantId, source_id: sourceId, url: link ?? src.url, title: it.title, summary: it.summary, published_at: published, observed_at: now,
        region: null, topic: topic?.topic ?? null, cluster_key: topic ? `${topic.topic}:${topic.keyword}` : null, metrics: '{}',
        evidence_strength: 'anecdotal', content_hash: hash(src.kind === 'user_link' ? `${normTitle(it.title)}|${src.url}` : normTitle(it.title)),
      }).onConflict((oc) => oc.columns(['source_id', 'content_hash']).doNothing()).returning('id').executeTakeFirst();
      if (r) stored++; else duplicates++;
    }
    await trx.updateTable('trend_sources').set({ status: 'active', last_error: items.length ? null : 'no_items', last_fetched_at: now }).where('id', '=', sourceId).execute();
  });
  return { ok: true, error: null, stored, duplicates, stale_skipped: stale };
}

/** Clusters recent observations and assesses fit with services and capacity (rules-based). */
export async function assessTrends(trx: Tx, tenantId: string, now = new Date()) {
  const sources = await trx.selectFrom('trend_sources').select(['id']).where('tenant_id', '=', tenantId).where('status', '!=', 'disabled').execute();
  if (!sources.length) return { sources: 0, clusters: 0, assessed: 0 };
  const t = await trx.selectFrom('tenants').select(['timezone', 'default_locale']).where('id', '=', tenantId).executeTakeFirstOrThrow();
  const L = (ar: string, en: string) => (t.default_locale === 'en' ? en : ar);
  const obs = await trx.selectFrom('trend_observations').select(['id', 'source_id', 'cluster_key', 'topic', 'published_at', 'metrics', 'title', 'content_hash'])
    .where('tenant_id', '=', tenantId).where('cluster_key', 'is not', null).where('published_at', 'is not', null)
    .where('published_at', '>', new Date(now.getTime() - 45 * 86_400_000)).execute();
  const services = await trx.selectFrom('services').select(['id', 'name_ar', 'name_en']).where('tenant_id', '=', tenantId).where('archived_at', 'is', null).where('is_active', '=', true).execute();
  const today = localToday(t.timezone, now);
  const free = (await computeOccupancy(trx, tenantId, t.timezone, today, addDays(today, 13))).totals;
  const freeMin = Math.max(0, free.available_min - free.booked_min);
  const clusters = new Map<string, typeof obs>();
  // The same story syndicated by several feeds (or a duplicate source) counts once.
  const seen = new Set<string>();
  for (const o of obs.sort((a, b) => a.published_at!.getTime() - b.published_at!.getTime())) {
    const k = `${o.cluster_key}|${o.content_hash}`;
    if (seen.has(k)) continue;
    seen.add(k);
    clusters.set(o.cluster_key!, [...(clusters.get(o.cluster_key!) ?? []), o]);
  }
  let assessed = 0;
  for (const [key, list] of clusters) {
    const topic = list[0]!.topic!;
    const distinct = new Set(list.map((o) => o.source_id)).size;
    const fresh = list.filter((o) => now.getTime() - o.published_at!.getTime() <= 30 * 86_400_000);
    const quantified = list.some((o) => o.metrics && Object.keys(o.metrics as object).length > 0);
    const strength = quantified ? 'quantified' : fresh.length >= 3 && new Set(fresh.map((o) => o.source_id)).size >= 2 ? 'early_signal' : 'anecdotal';
    const kws = TOPICS[topic] ?? [];
    const matched = services.find((s) => kws.some((k) => `${s.name_ar ?? ''} ${s.name_en ?? ''}`.toLowerCase().includes(k.toLowerCase())));
    const fit = matched ? (freeMin > 0 ? 'good' : 'partial') : 'poor';
    const name = matched ? (t.default_locale === 'en' ? matched.name_en || matched.name_ar : matched.name_ar || matched.name_en) : null;
    const latest = new Date(Math.max(...list.map((o) => o.published_at!.getTime())));
    const values = {
      observation_ids: list.map((o) => o.id),
      what_is_happening: L(`${list.length} منشورات من ${distinct} مصادر عن ${topic} خلال ٤٥ يوماً (ليست أخباراً موثّقة).`, `${list.length} items from ${distinct} sources about ${topic} in 45 days (not verified news).`),
      evidence_strength: strength,
      fit,
      fit_explanation: matched
        ? (freeMin > 0 ? L(`يتوافق مع خدمة "${name}" ويوجد وقت متاح خلال أسبوعين.`, `Matches your service "${name}" and there is free time in the next two weeks.`)
          : L(`يتوافق مع "${name}" لكن لا يوجد وقت متاح حالياً.`, `Matches "${name}" but there is no free time right now.`))
        : L('لا توجد خدمة لديك مرتبطة بهذا الموضوع.', 'None of your services relate to this topic.'),
      application_idea: matched ? L(`محتوى قصير يعرض "${name}" بصور حقيقية من أعمالك.`, `Short content showing "${name}" with real photos of your work.`) : null,
      est_time: L('غير مقدّر', 'Not estimated'),
      est_cost: L('غير مقدّر', 'Not estimated'),
      valid_until: addDays(latest.toISOString().slice(0, 10), 30),
      source_type: 'rules' as const,
    };
    const existing = await trx.selectFrom('trend_assessments').select(['id']).where('tenant_id', '=', tenantId).where('cluster_key', '=', key).where('status', '=', 'open').executeTakeFirst();
    if (existing) await trx.updateTable('trend_assessments').set(values).where('id', '=', existing.id).execute();
    else await trx.insertInto('trend_assessments').values({ tenant_id: tenantId, cluster_key: key, ...values }).execute();
    assessed++;
  }
  await sql`update trend_assessments set status = 'expired' where tenant_id = ${tenantId} and status = 'open' and valid_until < ${today}`.execute(trx);
  return { sources: sources.length, clusters: clusters.size, assessed };
}

export async function trendCards(access: TenantAccess) {
  return withTenant(access.tenantId, async (trx) => {
    const sources = await trx.selectFrom('trend_sources').select(['id', 'name', 'kind', 'url', 'status', 'last_error', 'last_fetched_at', 'access_basis']).where('tenant_id', '=', access.tenantId).execute();
    const cards = await trx.selectFrom('trend_assessments').selectAll().where('tenant_id', '=', access.tenantId).where('status', '=', 'open').orderBy('updated_at', 'desc').limit(20).execute();
    const ids = [...new Set(cards.flatMap((c) => c.observation_ids))];
    const obs = ids.length ? await trx.selectFrom('trend_observations as o').leftJoin('trend_sources as s', 's.id', 'o.source_id')
      .select(['o.id', 'o.title', 'o.url', 'o.published_at', 'o.observed_at', 'o.evidence_strength', 's.name as source_name']).where('o.id', 'in', ids).execute() : [];
    const now = Date.now();
    const active = sources.filter((s) => s.status === 'active');
    return {
      sources_status: !sources.length ? 'none' : !active.length ? 'all_unavailable' : 'connected',
      note: 'observations_are_not_verified_news',
      sources,
      cards: cards.map((c) => ({
        ...c,
        observations: obs.filter((o) => c.observation_ids.includes(o.id)).map((o) => ({ ...o, freshness: freshnessOf(o.published_at, now) }))
          .sort((a, b) => (b.published_at?.getTime() ?? 0) - (a.published_at?.getTime() ?? 0)).slice(0, 5),
      })),
    };
  });
}

export async function dismissTrend(access: TenantAccess, actor: AuditActor, id: string) {
  return withTenant(access.tenantId, async (trx) => {
    const r = await trx.updateTable('trend_assessments').set({ status: 'dismissed' }).where('id', '=', id).where('status', '=', 'open').returning('id').executeTakeFirst();
    if (!r) throw Errors.notFound('trend');
    await audit(trx, actor, 'marketing.trend_dismissed', { tenantId: access.tenantId, targetType: 'trend_assessment', targetId: id });
    return { id, status: 'dismissed' };
  });
}

/** Appends the trend idea to the current weekly plan as a NEW version (never silently). */
export async function addTrendToWeeklyPlan(access: TenantAccess, actor: AuditActor, id: string) {
  return withTenant(access.tenantId, async (trx) => {
    const a = await trx.selectFrom('trend_assessments').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
    if (!a || a.status !== 'open') throw Errors.notFound('trend');
    const today = localToday(access.timezone);
    const plan = await trx.selectFrom('marketing_plans as p').innerJoin('plan_versions as v', 'v.id', 'p.current_version_id')
      .select(['p.id', 'p.period_start', 'p.period_end', 'v.content']).where('p.tenant_id', '=', access.tenantId).where('p.kind', '=', 'weekly')
      .where('p.is_example', '=', false).where('p.status', 'not in', ['rejected', 'completed']).where('p.period_end', '>=', today)
      .orderBy('p.period_start').executeTakeFirst();
    if (!plan) throw Errors.conflict('no_weekly_plan', 'Create or generate a weekly plan first');
    const content = plan.content as PlanContent;
    const activity = {
      id: `t${content.activities.length + 1}-${a.id.slice(0, 6)}`, title: a.application_idea ?? a.what_is_happening, initiative_id: null,
      date_from: null, date_to: null, channel: null, content_idea: `${a.what_is_happening} — ${a.fit_explanation}`.slice(0, 1000), owner: content.owner,
      capacity_note: a.fit === 'good' ? null : a.fit, monthly_goal_ref: null, status: 'planned' as const,
    };
    const v = await appendVersion(trx, access.tenantId, plan.id, { content: { ...content, activities: [...content.activities, activity].slice(0, 60) }, source: 'manual', createdBy: actor.userId, changeNote: 'trend_added', validation: { status: 'manual', trend_assessment_id: a.id } });
    await trx.updateTable('trend_assessments').set({ status: 'added_to_plan' }).where('id', '=', id).execute();
    await audit(trx, actor, 'marketing.trend_added_to_plan', { tenantId: access.tenantId, targetType: 'marketing_plan', targetId: plan.id, data: { trend: id, version: v.version } });
    return { plan_id: plan.id, version: v.version };
  });
}

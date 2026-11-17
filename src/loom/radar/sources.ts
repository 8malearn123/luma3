import { audit, Errors, sql, withSystem, withTenant, type AuditActor } from '../db';
import { ensureConnection } from '../analysis/run';
import { connectorFor } from '../connectors/registry';
import type { CanonicalBusiness } from '../contracts/canonical';
import { render, type LoomLocale } from '../util/text';
import { backoffMs } from './calendar';
import { businessContext } from './context';
import { parseFeed, parseHtml } from './parse';
import { apiProvider, apiProviders, providerStatus, radarFetcher } from './ports';
import { signalRelevance } from './relevance';
import { clusterSignals, contentHashOf, DAY, dedupeKeyOf, freshnessOf, isLive, MAX_AGE_DAYS, signalEvidenceClass, titleTokens, validUntilOf, type ClusterInput } from './signals';
import { detectTopic } from './topics';
import { RadarFetchError, type RawSignal, type SignalSourceKind } from './types';

/**
 * Business signal sources (RSS feeds, user links, API providers) and the
 * fetch → store → cluster cycle. All fetching goes through the host's
 * SSRF-safe fetcher; stored text is untrusted_*. Idempotent: an item is
 * stored once per source (content hash) and marked duplicate_of when the
 * same story was already seen from another source (dedupe key).
 */
export const MAX_SOURCES = 20;
const HOUR = 3_600_000;
const REFRESH_MS = 6 * HOUR;
type Ctx = { businessId: string; actor: AuditActor };
export type SourceInput = { kind: SignalSourceKind; name: string; url?: string | null; provider?: string | null; query?: { q?: string; region?: string }; access_basis: string };

async function packIdOf(businessId: string) {
  const conn = await withTenant(businessId, (trx) => ensureConnection(trx, businessId));
  const b = (await connectorFor(conn.kind).pull(conn, 'business', null, 1)).records[0]?.data as CanonicalBusiness | undefined;
  return b?.sector ?? 'beauty';
}

const sourceView = <T extends { kind: string; provider: string | null; status: string }>(s: T) => {
  const conn = s.kind === 'api' ? providerStatus(s.provider!) : null;
  // API sources are «غير متصل» whenever their provider is not configured, whatever was stored.
  const connection = s.status === 'disabled' ? 'disabled' : conn && conn.state === 'disconnected' ? 'disconnected' : s.status === 'error' ? 'error' : 'connected';
  return { ...s, connection, connection_reason: conn && conn.state === 'disconnected' ? conn.reason : null };
};

export async function listSources(businessId: string) {
  const rows = await withTenant(businessId, (trx) => trx.selectFrom('loom.signal_sources').selectAll().where('business_id', '=', businessId).orderBy('created_at', 'desc').execute());
  return rows.map(sourceView);
}

export async function addSource(c: Ctx, input: SourceInput, now = new Date()) {
  if (input.kind === 'api') {
    if (!input.provider || !apiProvider(input.provider)) throw Errors.invalid('unknown_provider', 'Unknown API provider');
  } else {
    if (!input.url) throw Errors.invalid('url_required', 'A URL is required');
    try { await radarFetcher().assertPublic(input.url); } catch (e) {
      throw Errors.invalid('blocked_url', 'This address cannot be used as a source', { reason: e instanceof RadarFetchError ? e.code : 'invalid_url' });
    }
  }
  const src = await withTenant(c.businessId, async (trx) => {
    const n = await trx.selectFrom('loom.signal_sources').select(sql<number>`count(*)::int`.as('n')).where('business_id', '=', c.businessId).executeTakeFirstOrThrow();
    if (n.n >= MAX_SOURCES) throw Errors.invalid('too_many_sources', `Up to ${MAX_SOURCES} sources per business`);
    const status = input.kind === 'api' && providerStatus(input.provider!).state === 'disconnected' ? 'disconnected' : 'active';
    const row = await trx.insertInto('loom.signal_sources').values({
      business_id: c.businessId, kind: input.kind, provider: input.kind === 'api' ? input.provider! : null, name: input.name, url: input.kind === 'api' ? null : input.url!,
      query: JSON.stringify(input.query ?? {}), access_basis: input.access_basis, status, created_by: c.actor.userId, next_fetch_at: now,
    }).onConflict((oc) => oc.doNothing()).returningAll().executeTakeFirst();
    if (!row) throw Errors.conflict('duplicate_source', 'This source already exists');
    await audit(trx, c.actor, 'loom.signal_source_added', { tenantId: c.businessId, targetType: 'loom_signal_source', targetId: row.id, data: { kind: input.kind, url: input.url ?? null, provider: input.provider ?? null } });
    return row;
  });
  const fetched = src.status === 'active' ? await fetchSource(c.businessId, src.id, now) : { ok: false, error: 'not_configured', stored: 0, duplicates: 0, stale_skipped: 0 };
  return { source: sourceView((await listSources(c.businessId)).find((s) => s.id === src.id) ?? src), fetch: fetched };
}

export async function updateSource(c: Ctx, id: string, status: 'active' | 'disabled') {
  return withTenant(c.businessId, async (trx) => {
    const r = await trx.updateTable('loom.signal_sources').set({ status, next_fetch_at: new Date(), consecutive_failures: 0 }).where('business_id', '=', c.businessId).where('id', '=', id).returningAll().executeTakeFirst();
    if (!r) throw Errors.notFound('source');
    await audit(trx, c.actor, 'loom.signal_source_updated', { tenantId: c.businessId, targetType: 'loom_signal_source', targetId: id, data: { status } });
    return sourceView(r);
  });
}

export type FetchSummary = { ok: boolean; error: string | null; stored: number; duplicates: number; stale_skipped: number };

/** Fetches one source and stores new, deduplicated signals (never re-stores an item). */
export async function fetchSource(businessId: string, sourceId: string, now = new Date()): Promise<FetchSummary> {
  const src = await withTenant(businessId, (trx) => trx.selectFrom('loom.signal_sources').selectAll().where('business_id', '=', businessId).where('id', '=', sourceId).executeTakeFirst());
  if (!src) throw Errors.notFound('source');
  if (src.status === 'disabled') return { ok: false, error: 'source_disabled', stored: 0, duplicates: 0, stale_skipped: 0 };
  let items: RawSignal[];
  try {
    if (src.kind === 'api') {
      const p = apiProvider(src.provider!);
      if (!p || p.status().state !== 'connected') {
        await withTenant(businessId, (trx) => trx.updateTable('loom.signal_sources').set({ status: 'disconnected', last_error: 'not_configured', next_fetch_at: new Date(now.getTime() + 24 * HOUR) }).where('id', '=', sourceId).execute());
        return { ok: false, error: 'not_configured', stored: 0, duplicates: 0, stale_skipped: 0 };
      }
      items = await p.fetch(src.query as Record<string, unknown>, radarFetcher());
    } else {
      const res = await radarFetcher().fetch(src.url!, src.kind === 'user_link' ? 'html' : 'feed');
      items = /html/i.test(res.contentType) ? parseHtml(res.text) : parseFeed(res.text, src.url!);
    }
  } catch (e) {
    const code = e instanceof RadarFetchError ? e.code : 'network_error';
    const failures = src.consecutive_failures + 1;
    await withTenant(businessId, (trx) => trx.updateTable('loom.signal_sources').set({ status: 'error', last_error: code, last_fetched_at: now, consecutive_failures: failures, next_fetch_at: new Date(now.getTime() + backoffMs(failures)) }).where('id', '=', sourceId).execute());
    return { ok: false, error: code, stored: 0, duplicates: 0, stale_skipped: 0 };
  }
  const packId = await packIdOf(businessId);
  let stored = 0, duplicates = 0, stale = 0;
  await withTenant(businessId, async (trx) => {
    for (const it of items) {
      const published = it.published_at && it.published_at.getTime() <= now.getTime() + DAY ? it.published_at : null;
      if (published && now.getTime() - published.getTime() > MAX_AGE_DAYS * DAY) { stale++; continue; }
      const url = it.url ?? src.url;
      if (!url) continue;
      const dedupe = dedupeKeyOf(it.untrusted_title);
      const first = await trx.selectFrom('loom.signals').select('id').where('business_id', '=', businessId).where('dedupe_key', '=', dedupe).where('source_id', '!=', sourceId)
        .where('duplicate_of', 'is', null).orderBy('created_at').executeTakeFirst();
      const r = await trx.insertInto('loom.signals').values({
        business_id: businessId, source_id: sourceId, url, untrusted_title: it.untrusted_title, untrusted_summary: it.untrusted_summary, published_at: published, observed_at: now,
        region: it.region, topic: detectTopic(`${it.untrusted_title} ${it.untrusted_summary ?? ''}`, packId), title_tokens: titleTokens(it.untrusted_title),
        reach_metrics: it.reach_metrics ? JSON.stringify(it.reach_metrics) : null, evidence_class: signalEvidenceClass(it.reach_metrics),
        valid_until: validUntilOf(published?.getTime() ?? null), content_hash: contentHashOf(it.untrusted_title, src.kind, url), dedupe_key: dedupe, duplicate_of: first?.id ?? null,
      }).onConflict((oc) => oc.columns(['source_id', 'content_hash']).doNothing()).returning('id').executeTakeFirst();
      if (r) stored++; else duplicates++;
    }
    await trx.updateTable('loom.signal_sources').set({ status: 'active', last_error: items.length ? null : 'no_items', last_fetched_at: now, last_success_at: now, consecutive_failures: 0, next_fetch_at: new Date(now.getTime() + REFRESH_MS) })
      .where('id', '=', sourceId).execute();
  });
  return { ok: true, error: null, stored, duplicates, stale_skipped: stale };
}

/**
 * Re-clusters the business's signals (last 180 days), refreshes evidence
 * class, liveness and relevance. Decisions (dismissed / attached) are kept.
 */
export async function assessClusters(businessId: string, now = new Date()) {
  const { rc } = await businessContext(businessId);
  return withTenant(businessId, async (trx) => {
    const rows = await trx.selectFrom('loom.signals').select(['id', 'source_id', 'topic', 'title_tokens', 'published_at', 'observed_at', 'dedupe_key', 'duplicate_of', 'reach_metrics', 'untrusted_title', 'region'])
      .where('business_id', '=', businessId).where('observed_at', '>', new Date(now.getTime() - MAX_AGE_DAYS * DAY)).orderBy('observed_at', 'desc').limit(500).execute();
    const input: ClusterInput[] = rows.map((r) => ({ id: r.id, source_id: r.source_id, topic: r.topic, tokens: r.title_tokens, published_at: r.published_at?.getTime() ?? null, observed_at: r.observed_at.getTime(),
      dedupe_key: r.dedupe_key, duplicate_of: r.duplicate_of, reach_metrics: r.reach_metrics as Record<string, number> | null, untrusted_title: r.untrusted_title, region: r.region }));
    const clusters = clusterSignals(input, now.getTime());
    const keys: string[] = [];
    for (const c of clusters) {
      keys.push(c.cluster_key);
      const rel = c.liveness === 'live' ? signalRelevance({ topic: c.topic, region: c.region }, rc) : null;
      const values = {
        topic: c.topic, untrusted_label: c.untrusted_label, signal_ids: c.signal_ids, signal_count: c.signal_count, source_count: c.source_count, live_count: c.live_count,
        evidence_class: c.evidence_class, liveness: c.liveness, first_published_at: c.first_published_at ? new Date(c.first_published_at) : null,
        last_published_at: c.last_published_at ? new Date(c.last_published_at) : null, valid_until: c.valid_until, relevance: JSON.stringify(rel ?? {}), relevance_score: rel?.score ?? null,
      };
      await trx.insertInto('loom.signal_clusters').values({ business_id: businessId, cluster_key: c.cluster_key, ...values, status: 'open' })
        .onConflict((oc) => oc.columns(['business_id', 'cluster_key']).doUpdateSet({ ...values, status: sql`case when loom.signal_clusters.status = 'merged' then 'open' else loom.signal_clusters.status end` }))
        .execute();
    }
    let q = trx.updateTable('loom.signal_clusters').set({ status: 'merged' }).where('business_id', '=', businessId).where('status', '=', 'open');
    if (keys.length) q = q.where('cluster_key', 'not in', keys);
    await q.execute();
    return { signals: rows.length, clusters: clusters.length, live: clusters.filter((c) => c.liveness === 'live').length };
  });
}

/** Stale marking: clusters whose validity passed are no longer live (T7). */
export async function markStaleClusters(now = new Date()) {
  await withSystem('loom: stale clusters', (trx) => sql`update loom.signal_clusters set liveness = 'stale' where liveness = 'live' and (valid_until is null or valid_until < ${now.toISOString().slice(0, 10)}::date)`.execute(trx));
}

/** Periodic sweep: due sources (with backoff), then re-cluster touched businesses, then stale marking. Idempotent. */
export async function sweepSources(now = new Date(), limit = 50) {
  const due = await withSystem('loom: due sources', (trx) => trx.selectFrom('loom.signal_sources').select(['id', 'business_id'])
    .where('status', 'in', ['active', 'error', 'disconnected']).where('next_fetch_at', '<=', now).orderBy('next_fetch_at').limit(limit).execute());
  const touched = new Set<string>();
  for (const s of due) {
    // Claim with a short lease so a concurrent sweep does not fetch it again.
    const claimed = await withSystem('loom: claim source', (trx) => trx.updateTable('loom.signal_sources').set({ next_fetch_at: new Date(now.getTime() + 10 * 60_000) })
      .where('id', '=', s.id).where('next_fetch_at', '<=', now).returning('id').executeTakeFirst());
    if (!claimed) continue;
    try { const r = await fetchSource(s.business_id, s.id, now); if (r.stored) touched.add(s.business_id); } catch { /* recorded on the source */ }
  }
  for (const b of touched) await assessClusters(b, now).catch(() => undefined);
  await markStaleClusters(now);
  return { fetched: due.length, businesses: touched.size };
}

// ── Radar view ───────────────────────────────────────────────────────────────
export async function radarView(businessId: string, locale: LoomLocale, now = new Date()) {
  const sources = await listSources(businessId);
  return withTenant(businessId, async (trx) => {
    const clusters = await trx.selectFrom('loom.signal_clusters').selectAll().where('business_id', '=', businessId).where('status', '!=', 'merged')
      .orderBy('liveness').orderBy('relevance_score', (ob) => ob.desc().nullsLast()).orderBy('last_published_at', (ob) => ob.desc().nullsLast()).limit(80).execute();
    const ids = [...new Set(clusters.flatMap((c) => c.signal_ids))];
    const signals = ids.length ? await trx.selectFrom('loom.signals as s').innerJoin('loom.signal_sources as src', 'src.id', 's.source_id')
      .select(['s.id', 's.url', 's.untrusted_title', 's.untrusted_summary', 's.published_at', 's.observed_at', 's.region', 's.topic', 's.reach_metrics', 's.evidence_class', 's.valid_until', 's.duplicate_of', 'src.name as source_name', 'src.kind as source_kind'])
      .where('s.business_id', '=', businessId).where('s.id', 'in', ids).execute() : [];
    const opps = await trx.selectFrom('loom.opportunities').select(['id', 'card', 'status']).where('business_id', '=', businessId)
      .where('id', 'in', [...new Set(clusters.flatMap((c) => [c.opportunity_id, (c.relevance as { opportunity_id?: string }).opportunity_id]).filter((x): x is string => !!x))].concat(['00000000-0000-0000-0000-000000000000'])).execute();
    const oppView = (id: string | null | undefined) => { const o = opps.find((x) => x.id === id); return o ? { id: o.id, status: o.status, title: render((o.card as { title: { ar: string; en: string } }).title, locale) } : null; };
    const view = clusters.map((c) => {
      const rel = c.relevance as { score?: number; reasons?: Array<{ ar: string; en: string }>; opportunity_id?: string | null; factors?: Record<string, number> };
      const members = signals.filter((s) => c.signal_ids.includes(s.id)).map((s) => {
        const freshness = freshnessOf(s.published_at?.getTime() ?? null, now.getTime());
        return { ...s, freshness, live: isLive(freshness), cluster_id: c.id };
      }).sort((a, b) => (b.published_at?.getTime() ?? 0) - (a.published_at?.getTime() ?? 0));
      const live = c.liveness === 'live' && (!c.valid_until || c.valid_until >= now.toISOString().slice(0, 10));
      return {
        id: c.id, cluster_key: c.cluster_key, topic: c.topic, untrusted_label: c.untrusted_label, evidence_class: c.evidence_class, liveness: live ? 'live' as const : 'stale' as const,
        signal_count: c.signal_count, source_count: c.source_count, live_count: c.live_count, valid_until: c.valid_until, first_published_at: c.first_published_at, last_published_at: c.last_published_at,
        status: c.status, relevance: live && rel.score !== undefined ? { score: rel.score, factors: rel.factors ?? {}, reasons: (rel.reasons ?? []).map((r) => render(r, locale)) } : null,
        suggested_opportunity: live ? oppView(rel.opportunity_id) : null, attached_opportunity: oppView(c.opportunity_id), planned_ref: c.planned_ref, signals: members.slice(0, 8),
      };
    });
    const external = sources.filter((s) => s.connection !== 'disabled');
    return {
      note: 'signals_are_not_verified_news',
      external_status: !external.length ? 'none' : external.every((s) => s.connection !== 'connected') ? 'all_unavailable' : external.some((s) => s.connection !== 'connected') ? 'partial' : 'connected',
      providers: apiProviders().map((p) => ({ id: p.id, label: render(p.label, locale), status: p.status() })),
      sources,
      clusters: view.filter((c) => c.liveness === 'live' && c.status !== 'dismissed'),
      stale: view.filter((c) => c.liveness === 'stale' && c.status !== 'dismissed').slice(0, 20),
      dismissed: view.filter((c) => c.status === 'dismissed').slice(0, 20),
    };
  });
}

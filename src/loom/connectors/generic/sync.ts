import { createHash } from 'node:crypto';
import { AppError, Errors, sql, withSystem, withTenant, type Tx } from '../../db';
import type { ConnectionRef } from '../../contracts/connector';
import { loadDataset } from '../../dataset';
import { MetricContext } from '../../metrics/context';
import '../../metrics/v1';
import { qualityGate } from '../../quality/gate';
import { applyPackQuality, sectorPack } from '../../sector/packs';
import { LoomHttpError, loomSecrets } from '../../runtime';
import { readPlatformSettings } from '../../settings/platform';
import { SignatureError } from '../../webhooks/signing';
import { CsvConnector } from './csv';
import { normalizeRows, type Mapping } from './mapping';
import { restConfigSchema, RestConnector, WebhookPayloadError } from './rest';
import { readMapping } from './staged';
import { detectLinks, liveCounts, stageRecords, type StageResult } from './store';
import { SOURCE_ENTITIES, type SourceEntity } from './templates';
import { parseCsv } from './csv-parse';

/**
 * Sync and review of staged connections.
 *
 *   sync    → source rows (latest valid CSV file per entity past the cursor,
 *             or every REST page) → mapping → staging store (dedupe,
 *             tombstones, entity links) → first-snapshot review.
 *   review  → the canonical dataset is built through the connector exactly as
 *             an analysis would, the quality gate runs on it, and blockers are
 *             listed. A connection becomes `pending_review` only without
 *             blockers; analyses use it only after a human approves it
 *             (§16: mappings + quality gate + human review of the first snapshot).
 */
export const csvConnector = new CsvConnector();
export const restConnector = new RestConnector();

type ConnRow = { id: string; business_id: string; kind: string; status: string; config: unknown; review_status: string; cursors: unknown; secret_enc: string | null; ingest_secret_enc: string | null };

export const refOf = (c: Pick<ConnRow, 'id' | 'business_id' | 'kind' | 'config'>): ConnectionRef => ({ id: c.id, business_id: c.business_id, kind: c.kind, config: (c.config ?? {}) as Record<string, unknown> });

async function loadConn(trx: Tx, businessId: string, id: string) {
  const c = await trx.selectFrom('loom.connections').select(['id', 'business_id', 'kind', 'status', 'config', 'review_status', 'cursors', 'secret_enc', 'ingest_secret_enc'])
    .where('business_id', '=', businessId).where('id', '=', id).executeTakeFirst();
  if (!c) throw Errors.notFound('connection');
  return c as ConnRow;
}

export type Review = {
  snapshot_at: string; counts: Record<string, number>; quality: { overall: string; levels: Record<string, string>; exploratory: boolean };
  unmapped_statuses: number; inconsistent: number; links: number; blockers: string[]; ready: boolean;
};

/** First-snapshot review: the dataset exactly as an analysis would read it, plus the quality gate. */
export async function reviewSnapshot(businessId: string, conn: ConnectionRef, now = new Date()): Promise<Review> {
  const platform = await withSystem('loom: settings for connection review', (trx) => readPlatformSettings(trx));
  const connector = conn.kind === 'rest' ? restConnector : csvConnector;
  const ds = await loadDataset(connector, { ...conn, as_of: now });
  const ctx = new MetricContext(ds, { cost_completeness_threshold: platform.cost_completeness_threshold });
  const packId = (await withTenant(businessId, (trx) => trx.selectFrom('loom.businesses').select('sector_pack').where('id', '=', businessId).executeTakeFirst()))?.sector_pack ?? ds.business.sector;
  const q = applyPackQuality(qualityGate(ctx), sectorPack(packId));
  const { unmapped, links } = await withTenant(businessId, async (trx) => ({
    unmapped: Number((await trx.selectFrom('loom.canonical_records').select((eb) => eb.fn.countAll<number>().as('n')).where('business_id', '=', businessId)
      .where('connection_id', '=', conn.id).where('entity', '=', 'transactions').where('deleted_at', 'is', null)
      .where(sql<boolean>`data->>'status' is null`).executeTakeFirstOrThrow()).n),
    links: Number((await trx.selectFrom('loom.entity_links').select((eb) => eb.fn.countAll<number>().as('n')).where('business_id', '=', businessId).where('connection_id', '=', conn.id).where('status', '=', 'suggested').executeTakeFirstOrThrow()).n),
  }));
  const blockers: string[] = [];
  if (!ds.offerings.some((o) => o.status === 'active')) blockers.push('no_active_offerings');
  if (!ds.transactions.length) blockers.push('no_transactions');
  if (unmapped > 0) blockers.push('unmapped_statuses');
  if (q.overall === 'insufficient') blockers.push('quality_insufficient');
  const inconsistent = ds.transactions.filter((t) => !t.consistent).length;
  if (ds.transactions.length && inconsistent / ds.transactions.length > 0.2) blockers.push('inconsistent_transactions');
  return {
    snapshot_at: now.toISOString(), counts: ds.meta.counts,
    quality: { overall: q.overall, levels: Object.fromEntries(Object.entries(q.domains).map(([k, v]) => [k, v.level])), exploratory: q.exploratory },
    unmapped_statuses: unmapped, inconsistent, links, blockers, ready: blockers.length === 0,
  };
}

function nextReviewStatus(current: string, review: Review) {
  if (current === 'approved') return review.ready ? 'approved' : 'pending_mapping';
  return review.ready ? 'pending_review' : 'pending_mapping';
}

async function stageEntity(trx: Tx, c: ConnRow, m: Mapping, entity: SourceEntity, rows: Array<Record<string, unknown>>, full: boolean, origin: 'csv' | 'rest' | 'webhook') {
  const n = normalizeRows(entity, rows, m);
  const staged = await stageRecords(trx, { businessId: c.business_id, connectionId: c.id, entity, rows: n.rows, fullSnapshot: full, origin });
  return { ...staged, errors: n.error_count, unmapped_statuses: n.unmapped_statuses };
}

export type SyncResult = { status: 'succeeded' | 'failed'; entities: Record<string, StageResult & { errors: number; unmapped_statuses: string[]; file_version?: number }>; error?: string; review: Review | null; review_status: string };

export async function syncConnection(businessId: string, connectionId: string, opts: { now?: Date } = {}): Promise<SyncResult> {
  const started = new Date();
  const c = await withTenant(businessId, (trx) => loadConn(trx, businessId, connectionId));
  if (c.kind !== 'csv_import' && c.kind !== 'rest') throw Errors.invalid('not_a_staged_connection', 'This connection is read live by its connector');
  if (c.status === 'paused') throw Errors.conflict('connection_paused', 'Resume the connection first');
  const m = await withTenant(businessId, (trx) => readMapping(trx, businessId, connectionId));
  if (!m) throw Errors.conflict('mapping_required', 'Complete the mapping step before syncing');
  const entities: SyncResult['entities'] = {};
  let error: string | undefined;
  try {
    if (c.kind === 'csv_import') {
      await withTenant(businessId, async (trx) => {
        const cursors = { ...((c.cursors ?? {}) as Record<string, number>) };
        for (const entity of SOURCE_ENTITIES) {
          const file = await trx.selectFrom('loom.import_files').select(['id', 'version', 'content']).where('business_id', '=', businessId).where('connection_id', '=', connectionId)
            .where('entity', '=', entity).where('status', '=', 'valid').where('version', '>', cursors[entity] ?? 0).orderBy('version', 'desc').executeTakeFirst();
          if (!file) continue;
          const parsed = parseCsv(file.content);
          entities[entity] = { ...(await stageEntity(trx, c, m, entity, parsed.rows, true, 'csv')), file_version: file.version };
          await trx.updateTable('loom.import_files').set({ status: 'applied', applied_at: new Date() }).where('id', '=', file.id).execute();
          await trx.updateTable('loom.import_files').set({ status: 'superseded' }).where('connection_id', '=', connectionId).where('entity', '=', entity).where('status', '=', 'valid').where('version', '<', file.version).execute();
          cursors[entity] = file.version;
        }
        await trx.updateTable('loom.connections').set({ cursors: JSON.stringify(cursors) }).where('id', '=', connectionId).execute();
      });
    } else {
      const cfg = restConfigSchema.parse(c.config);
      const secret = c.secret_enc ? loomSecrets().open(c.secret_enc) : null;
      const fetched: Array<[SourceEntity, Array<Record<string, unknown>>, boolean]> = [];
      for (const entity of SOURCE_ENTITIES) {
        if (!cfg.paths[entity]) continue;
        const r = await restConnector.fetchEntity(cfg, entity, secret);
        fetched.push([entity, r.rows, r.complete]);
      }
      await withTenant(businessId, async (trx) => {
        for (const [entity, rows, complete] of fetched) entities[entity] = await stageEntity(trx, c, m, entity, rows, complete, 'rest');
      });
    }
  } catch (e) {
    if (e instanceof AppError) throw e;
    error = e instanceof LoomHttpError ? `http:${e.code}` : (e as Error).message.slice(0, 300);
  }
  const ref = refOf(c);
  const review = error ? null : await reviewSnapshot(businessId, ref, opts.now);
  return withTenant(businessId, async (trx) => {
    const counts = await liveCounts(trx, businessId, connectionId);
    const status = error ? 'failed' as const : 'succeeded' as const;
    await trx.insertInto('loom.sync_runs').values({ business_id: businessId, connection_id: connectionId, kind: 'sync', status, entities: JSON.stringify(Object.fromEntries(Object.entries(entities).map(([k, v]) => [k, { ...v }]))), data_version: null, error: error ?? null, started_at: started }).execute();
    const cur = await loadConn(trx, businessId, connectionId);
    const reviewStatus = review ? nextReviewStatus(cur.review_status, review) : cur.review_status;
    await trx.updateTable('loom.connections').set({
      last_sync_at: new Date(), last_error: error ?? null, status: error ? 'error' : cur.status === 'error' ? 'active' : cur.status, record_counts: JSON.stringify(counts),
      ...(review ? { review: JSON.stringify(review), review_status: reviewStatus } : {}),
    }).where('id', '=', connectionId).execute();
    return { status, entities, error, review, review_status: reviewStatus };
  });
}

// ── Inbound webhooks ────────────────────────────────────────────────────────
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/v1/loom/ingest/{connection}. The connection id in the path is
 * untrusted: it is looked up in system scope only to find the business and
 * the ingest secret; everything after the signature check runs inside
 * withTenant(business). Idempotent by event id (loom.ingest_events).
 */
export async function ingestWebhook(connectionId: string, req: Request, opts: { now?: Date } = {}) {
  if (!UUID.test(connectionId)) throw Errors.notFound('connection');
  const c = await withSystem('loom: resolve ingest connection', (trx) => trx.selectFrom('loom.connections')
    .select(['id', 'business_id', 'kind', 'status', 'config', 'review_status', 'cursors', 'secret_enc', 'ingest_secret_enc']).where('id', '=', connectionId).executeTakeFirst()) as ConnRow | undefined;
  if (!c || c.kind !== 'rest' || !c.ingest_secret_enc) throw Errors.notFound('connection');
  let events;
  try {
    events = await restConnector.verifyWebhook(req, { conn: refOf(c), secret: loomSecrets().open(c.ingest_secret_enc), now: opts.now });
  } catch (e) {
    if (e instanceof SignatureError) throw new AppError(401, e.code, 'Invalid webhook signature');
    if (e instanceof WebhookPayloadError) throw Errors.invalid(e.code);
    throw e;
  }
  if (c.status === 'paused') throw Errors.conflict('connection_paused');
  const eventId = events[0]!.event_id!;
  const signedAt = new Date(events[0]!.at);
  return withTenant(c.business_id, async (trx) => {
    const dup = await trx.selectFrom('loom.ingest_events').select(['result']).where('business_id', '=', c.business_id).where('connection_id', '=', c.id).where('event_id', '=', eventId).executeTakeFirst();
    if (dup) return { duplicate: true, event_id: eventId, result: dup.result };
    const m = await readMapping(trx, c.business_id, c.id);
    if (!m) throw Errors.conflict('mapping_required', 'Complete the mapping step before sending events');
    const byEntity = new Map<SourceEntity, Array<Record<string, unknown>>>();
    for (const e of events) {
      const row = { ...(e.data as Record<string, unknown>), ...(e.op === 'delete' ? { _op: 'delete' } : {}) };
      byEntity.set(e.entity as SourceEntity, [...(byEntity.get(e.entity as SourceEntity) ?? []), row]);
    }
    const result: Record<string, unknown> = {};
    for (const [entity, rows] of byEntity) result[entity] = await stageEntity(trx, c, m, entity, rows, false, 'webhook');
    const ins = await trx.insertInto('loom.ingest_events').values({ business_id: c.business_id, connection_id: c.id, event_id: eventId, signed_at: signedAt, records: events.length, result: JSON.stringify(result) })
      .onConflict((oc) => oc.columns(['connection_id', 'event_id']).doNothing()).returning('id').executeTakeFirst();
    if (!ins) throw Errors.conflict('duplicate_event', 'This event is being processed');
    await trx.insertInto('loom.sync_runs').values({ business_id: c.business_id, connection_id: c.id, kind: 'ingest', status: 'succeeded', entities: JSON.stringify(result), started_at: new Date() }).execute();
    await trx.updateTable('loom.connections').set({ last_sync_at: new Date(), record_counts: JSON.stringify(await liveCounts(trx, c.business_id, c.id)) }).where('id', '=', c.id).execute();
    return { duplicate: false, event_id: eventId, result };
  });
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export { detectLinks };

import { sql, type Tx } from '../../db';
import type { NormalizedRow } from './mapping';

/**
 * Staging store of staged connectors (loom.canonical_records). Dedupe key is
 * (connection, entity, source_id); an unchanged source_version is not
 * rewritten; deletions are tombstones (deleted_at), never physical deletes.
 * Suspected duplicates are recorded in loom.entity_links with a confidence
 * and are never merged automatically.
 */
export type StageResult = { inserted: number; updated: number; unchanged: number; tombstoned: number; restored: number; links: number };

export async function stageRecords(trx: Tx, o: { businessId: string; connectionId: string; entity: string; rows: NormalizedRow[]; fullSnapshot: boolean; origin: 'csv' | 'rest' | 'webhook' }): Promise<StageResult> {
  const existing = await trx.selectFrom('loom.canonical_records').select(['source_id', 'source_version', 'deleted_at'])
    .where('business_id', '=', o.businessId).where('connection_id', '=', o.connectionId).where('entity', '=', o.entity).execute();
  const byId = new Map(existing.map((r) => [r.source_id, r]));
  const r: StageResult = { inserted: 0, updated: 0, unchanged: 0, tombstoned: 0, restored: 0, links: 0 };
  // Last occurrence of a source id in a batch wins.
  const batch = new Map<string, NormalizedRow>();
  for (const row of o.rows) batch.set(row.source_id, row);
  const now = new Date();
  const upserts: NormalizedRow[] = [];
  const deletes: string[] = [];
  for (const row of batch.values()) {
    const cur = byId.get(row.source_id);
    if (row.op === 'delete') { if (cur && !cur.deleted_at) deletes.push(row.source_id); continue; }
    if (!cur) { r.inserted++; upserts.push(row); continue; }
    if (cur.deleted_at) { r.restored++; upserts.push(row); continue; }
    if (cur.source_version === row.source_version) { r.unchanged++; continue; }
    r.updated++; upserts.push(row);
  }
  if (o.fullSnapshot) for (const cur of existing) if (!cur.deleted_at && !batch.has(cur.source_id)) deletes.push(cur.source_id);
  for (let i = 0; i < upserts.length; i += 500) {
    await trx.insertInto('loom.canonical_records').values(upserts.slice(i, i + 500).map((x) => ({
      business_id: o.businessId, connection_id: o.connectionId, entity: o.entity, source_id: x.source_id, source_version: x.source_version,
      data: JSON.stringify(x.data), origin: o.origin,
    }))).onConflict((oc) => oc.columns(['connection_id', 'entity', 'source_id']).doUpdateSet((eb) => ({
      data: eb.ref('excluded.data'), source_version: eb.ref('excluded.source_version'), deleted_at: null, origin: eb.ref('excluded.origin'), updated_at: now,
    }))).execute();
  }
  for (let i = 0; i < deletes.length; i += 1000) {
    const res = await trx.updateTable('loom.canonical_records').set({ deleted_at: now }).where('business_id', '=', o.businessId).where('connection_id', '=', o.connectionId)
      .where('entity', '=', o.entity).where('source_id', 'in', deletes.slice(i, i + 1000)).where('deleted_at', 'is', null).executeTakeFirst();
    r.tombstoned += Number(res.numUpdatedRows);
  }
  if (o.entity === 'customers' || o.entity === 'offerings') r.links = await detectLinks(trx, o.businessId, o.connectionId, o.entity);
  return r;
}

const normName = (s: unknown) => String(s ?? '').toLowerCase().replace(/[\sً-ٟـ._-]+/g, ' ').trim();

/**
 * Suspected duplicates among live records: customers with the same hashed
 * contact key (confidence 0.9), offerings with the same normalised name and
 * kind (0.5). Pairs are suggestions for a human; nothing is merged.
 */
export async function detectLinks(trx: Tx, businessId: string, connectionId: string, entity: 'customers' | 'offerings') {
  const live = await trx.selectFrom('loom.canonical_records').select(['source_id', 'data']).where('business_id', '=', businessId)
    .where('connection_id', '=', connectionId).where('entity', '=', entity).where('deleted_at', 'is', null).execute();
  const groups = new Map<string, string[]>();
  for (const r of live) {
    const d = r.data as Record<string, unknown>;
    const k = entity === 'customers' ? (d.dup_key ? `k:${d.dup_key}` : null) : `${d.kind}:${normName(d.name)}`;
    if (!k || k.endsWith(':')) continue;
    groups.set(k, [...(groups.get(k) ?? []), r.source_id]);
  }
  const pairs: Array<{ a: string; b: string }> = [];
  for (const ids of groups.values()) {
    if (ids.length < 2) continue;
    const s = [...ids].sort();
    for (let i = 1; i < s.length && pairs.length < 1000; i++) pairs.push({ a: s[0]!, b: s[i]! });
  }
  if (!pairs.length) return 0;
  const res = await trx.insertInto('loom.entity_links').values(pairs.map((p) => ({
    business_id: businessId, connection_id: connectionId, entity, source_id_a: p.a, source_id_b: p.b,
    reason: entity === 'customers' ? 'same_contact_hash' as const : 'same_name' as const, confidence: entity === 'customers' ? 0.9 : 0.5,
  }))).onConflict((oc) => oc.columns(['connection_id', 'entity', 'source_id_a', 'source_id_b']).doNothing()).executeTakeFirst();
  return Number(res.numInsertedOrUpdatedRows ?? 0);
}

/** Live (non-tombstoned) records of one entity, keyset-paged by source_id. */
export async function readLive(trx: Tx, businessId: string, connectionId: string, entity: string, after: string | null, limit: number) {
  let q = trx.selectFrom('loom.canonical_records').select(['source_id', 'source_version', 'data']).where('business_id', '=', businessId)
    .where('connection_id', '=', connectionId).where('entity', '=', entity).where('deleted_at', 'is', null);
  if (after !== null) q = q.where('source_id', '>', after);
  return q.orderBy('source_id').limit(limit).execute();
}

export async function liveCounts(trx: Tx, businessId: string, connectionId: string) {
  const rows = await sql<{ entity: string; live: number; tombstoned: number }>`select entity, count(*) filter (where deleted_at is null)::int as live,
    count(*) filter (where deleted_at is not null)::int as tombstoned from loom.canonical_records
    where business_id = ${businessId} and connection_id = ${connectionId} group by entity order by entity`.execute(trx);
  return Object.fromEntries(rows.rows.map((r) => [r.entity, { live: r.live, tombstoned: r.tombstoned }]));
}

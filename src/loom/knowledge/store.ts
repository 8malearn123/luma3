import { sql, withSystem, type Tx } from '../db';
import { knowledgeLibrary, parseKnowledgeRef, rankUnits, unitHash, type KnowledgeQuery, type RetrievedUnit } from './library';

/**
 * Storage of the knowledge layer: loom.knowledge_units (global, insert-only
 * mirror of the code library) and loom.knowledge_citations (per business,
 * append-only, RLS).
 */
let synced = false;
export async function syncKnowledgeLibrary() {
  if (synced) return;
  await withSystem('loom: sync knowledge library', async (trx) => {
    for (const u of knowledgeLibrary()) {
      await trx.insertInto('loom.knowledge_units').values({
        id: u.id, version: u.version, sectors: u.applies_to.sectors, detectors: u.applies_to.detectors, interventions: u.applies_to.interventions,
        channels: u.applies_to.channels, title: JSON.stringify(u.title), guidance: JSON.stringify(u.guidance), when_not_to_use: JSON.stringify(u.when_not_to_use),
        common_mistakes: JSON.stringify(u.common_mistakes), measurement: JSON.stringify(u.measurement), examples: JSON.stringify(u.examples),
        source: JSON.stringify(u.source), reviewed_at: u.source.reviewed_at, owner: u.owner, content_hash: unitHash(u),
      }).onConflict((oc) => oc.columns(['id', 'version']).doNothing()).execute();
    }
  });
  synced = true;
}
/** Tests that truncate schema loom call this to force a re-sync. */
export function resetKnowledgeSync() { synced = false; }

/**
 * Retrieval for a business's sector. The hard sector/detector filter runs in
 * SQL (GIN on arrays) and again in code; ranking is lexical (pgvector is not
 * required at this size).
 */
export async function retrieveKnowledge(trx: Tx, q: KnowledgeQuery, today: string): Promise<RetrievedUnit[]> {
  await syncKnowledgeLibrary();
  const arr = (v: string) => sql<string[]>`array[${v}]::text[]`;
  let qb = trx.selectFrom('loom.knowledge_units').select(['id', 'version']).where('sectors', '@>', arr(q.sector));
  const det = q.detector ?? null, int = q.intervention ?? null;
  if (det && int) qb = qb.where((eb) => eb.or([eb('detectors', '@>', arr(det)), eb('interventions', '@>', arr(int))]));
  else if (det) qb = qb.where('detectors', '@>', arr(det));
  else if (int) qb = qb.where('interventions', '@>', arr(int));
  const rows = await qb.execute();
  const allowed = new Set(rows.map((r) => `${r.id}@${r.version}`));
  const lib = knowledgeLibrary().filter((u) => allowed.has(`${u.id}@${u.version}`));
  return rankUnits(lib, q, today);
}

export type CitationIn = { ref: string; opportunity_id?: string | null; plan_action_id?: string | null; planner_run_id?: string | null; item_ref: string; used_by: 'planner_ai' | 'rules' };

export async function recordCitations(trx: Tx, businessId: string, items: CitationIn[]) {
  const rows = items.flatMap((c) => {
    const r = parseKnowledgeRef(c.ref);
    return r ? [{ business_id: businessId, unit_id: r.id, unit_version: r.version, opportunity_id: c.opportunity_id ?? null, plan_action_id: c.plan_action_id ?? null, planner_run_id: c.planner_run_id ?? null, item_ref: c.item_ref, used_by: c.used_by }] : [];
  });
  for (let i = 0; i < rows.length; i += 200) await trx.insertInto('loom.knowledge_citations').values(rows.slice(i, i + 200)).execute();
  return rows.length;
}

/** Titles of cited units for display («مرجع المنهجية»). */
export function knowledgeTitles(refs: string[]) {
  const lib = new Map(knowledgeLibrary().map((u) => [`${u.id}@${u.version}`, u]));
  return refs.flatMap((r) => { const u = lib.get(r); return u ? [{ ref: r, title: u.title, source: u.source, measurement: u.measurement }] : []; });
}

/** Read-only list for the platform owner (/platform/loom). */
export async function listKnowledgeUnits(today: string) {
  await syncKnowledgeLibrary();
  const rows = await withSystem('loom: list knowledge units', (trx) => trx.selectFrom('loom.knowledge_units').selectAll().orderBy('id').orderBy('version', 'desc').execute());
  const counts = await withSystem('loom: knowledge citation counts', (trx) => trx.selectFrom('loom.knowledge_citations').select(['unit_id', (eb) => eb.fn.countAll<number>().as('n')]).groupBy('unit_id').execute());
  const byUnit = new Map(counts.map((c) => [c.unit_id, Number(c.n)]));
  const lib = new Map(knowledgeLibrary().map((u) => [`${u.id}@${u.version}`, u]));
  return rows.map((r) => {
    const u = lib.get(`${r.id}@${r.version}`);
    return {
      id: r.id, version: r.version, current: !!u, sectors: r.sectors, detectors: r.detectors, interventions: r.interventions, channels: r.channels,
      title: r.title, guidance: r.guidance, when_not_to_use: r.when_not_to_use, measurement: r.measurement, examples: r.examples, source: r.source,
      reviewed_at: r.reviewed_at, owner: r.owner, needs_review: u ? (new Date(`${r.reviewed_at}T00:00:00Z`).getTime() + 365 * 86_400_000) < new Date(`${today}T00:00:00Z`).getTime() : false,
      citations: byUnit.get(r.id) ?? 0,
    };
  });
}

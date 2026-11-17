import { CANONICAL_ENTITIES, type CanonicalDataset, type CanonicalEntity } from './contracts/canonical';
import type { ConnectionRef, LoomConnector } from './contracts/connector';
import { stableHash } from './util/text';
import { addDays, localToday } from './util/time';

const PAGE = 5000;

/** Pulls every canonical entity through a connector (following cursors) and assembles the dataset of one analysis. */
export async function loadDataset(connector: LoomConnector, conn: ConnectionRef): Promise<CanonicalDataset> {
  const now = conn.as_of ?? new Date();
  const conn2 = { ...conn, as_of: now };
  const data: Partial<Record<CanonicalEntity, unknown[]>> = {};
  const versions: Record<string, string> = {};
  const synced: Record<string, number> = {};
  for (const entity of CANONICAL_ENTITIES) {
    const recs: Array<{ id: string; v: string; data: unknown }> = [];
    let cursor: string | null = null;
    do {
      const page = await connector.pull(conn2, entity, cursor, PAGE);
      for (const r of page.records) if (r.op === 'upsert') recs.push({ id: r.source_id, v: r.source_version, data: r.data });
      cursor = page.next_cursor;
    } while (cursor);
    data[entity] = recs.map((r) => r.data);
    versions[entity] = stableHash(recs.map((r) => [r.id, r.v])).slice(0, 16);
    synced[entity] = Date.now();
  }
  const business = (data.business?.[0] ?? null) as CanonicalDataset['business'] | null;
  if (!business) throw new Error('connector returned no business record');
  const today = localToday(business.timezone, now);
  const get = <T>(e: CanonicalEntity) => (data[e] ?? []) as T[];
  const ds: CanonicalDataset = {
    business,
    locations: get('locations'), offerings: get('offerings'), requirements: get('offering_requirements'), inventory: get('inventory_items'),
    resources: get('resources'), capacity: get('capacity_windows'), transactions: get('transactions'), costs: get('cost_facts'),
    demand: get('demand_signals'), reviews: get('reviews'), complaints: get('complaints'), customers: get('customers'), campaigns: get('campaigns'),
    calendar: get('calendar_events'), signals: get('market_signals'),
    host_preferences: (get<CanonicalDataset['host_preferences']>('host_preferences')[0] ?? null),
    meta: {
      connection_id: conn.id, connector: connector.kind, as_of: now.getTime(), today,
      lookback_from: addDays(today, -90), horizon_to: addDays(today, 13), past_capacity_from: addDays(today, -28),
      data_version: stableHash(versions).slice(0, 24), entity_versions: versions,
      counts: Object.fromEntries(CANONICAL_ENTITIES.map((e) => [e, (data[e] ?? []).length])), synced_at: synced,
      revenue_basis: connector.describe().revenue_basis,
    },
  };
  return ds;
}

/** Content hash of a dataset, independent of the instant it was read (same data ⇒ same hash). */
export function datasetHash(ds: CanonicalDataset) {
  return stableHash({ ...ds, meta: { ...ds.meta, as_of: null, synced_at: null } });
}

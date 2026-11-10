import { withTenant, type Tx } from '../db';
import { ensureConnection } from '../analysis/run';
import { connectorFor } from '../connectors/registry';
import type { CalendarEvent, CanonicalBusiness, Offering } from '../contracts/canonical';
import { OPEN_STATUSES, type CardContent } from '../contracts/opportunity';
import { sectorPack } from '../sector/beauty';
import type { OpenOpportunity, RelevanceContext } from './relevance';

/** Opportunity statuses an external item may be attached to (open or accepted, never closed). */
export const ATTACHABLE_STATUSES = [...OPEN_STATUSES, 'accepted', 'deferred'] as const;

export async function openOpportunities(trx: Tx, businessId: string): Promise<OpenOpportunity[]> {
  const rows = await trx.selectFrom('loom.opportunities').select(['id', 'category', 'subject', 'card', 'priority_rank', 'status'])
    .where('business_id', '=', businessId).where('status', 'in', [...ATTACHABLE_STATUSES]).execute();
  return rows.map((o) => {
    const card = o.card as CardContent;
    return { id: o.id, category: o.category, offering_ids: (o.subject as { offering_ids?: string[] }).offering_ids ?? [], period: card.period, action_kind: card.recommended_action.kind, rank: o.priority_rank, title: card.title };
  });
}

/** Business, active offerings and owner-verified calendar events through the connector (never public tables). */
export async function businessContext(businessId: string): Promise<{ business: CanonicalBusiness | null; offerings: Offering[]; ownerEvents: CalendarEvent[]; rc: RelevanceContext }> {
  const conn = await withTenant(businessId, (trx) => ensureConnection(trx, businessId));
  const connector = connectorFor(conn.kind);
  const business = ((await connector.pull(conn, 'business', null, 1)).records[0]?.data ?? null) as CanonicalBusiness | null;
  const offerings = ((await connector.pull(conn, 'offerings', null, 1000)).records.map((r) => r.data) as Offering[]).filter((o) => o.status === 'active');
  const ownerEvents = (await connector.pull(conn, 'calendar_events', null, 1000)).records.map((r) => r.data) as CalendarEvent[];
  const opportunities = await withTenant(businessId, (trx) => openOpportunities(trx, businessId));
  const pack = sectorPack(business?.sector ?? 'beauty');
  return {
    business, offerings, ownerEvents,
    rc: { packId: pack.id, city: business?.city ?? null, offerings: offerings.map((o) => ({ id: o.id, name: o.name })), opportunities, awarenessOnlyTopics: pack.validation.awarenessOnlyTopics },
  };
}

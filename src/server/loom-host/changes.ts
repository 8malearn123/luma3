import { CHANGE_TOPIC, loomEngaged, recordChange, setPlanRevisionPort, type ChangeInput } from '@/loom';
import { withTenant } from '../db/client';
import { onDomainEvent } from '../infra/domain-events';
import { enqueue } from '../infra/outbox';
import { registerOutbox } from '../jobs/registry';
import { lumaPlanRevisions } from './plan-revisions';

/**
 * LUMA → Loom change events (§13). Imported once from src/server/boot.ts.
 *  - stock movements, approved leave and service price/cost changes emit
 *    domain events (src/server/infra/domain-events.ts) inside the domain
 *    transaction; for businesses that use Loom they are enqueued on the outbox
 *    topic `loom.change` (same transaction ⇒ never lost, never blocking) and
 *    recorded as change signals by Loom's outbox handler (src/loom/jobs.ts);
 *  - a confirmed booking (outbox topic `booking.confirmed`) records an
 *    occupancy change per booked service;
 *  - the default PlanRevisionPort appends revision versions (./plan-revisions.ts).
 * Thresholds, aggregation and cool-down are Loom's (src/loom/memory/changes.ts).
 */
const g = globalThis as unknown as { __loomHostChanges?: boolean };
if (!g.__loomHostChanges) {
  g.__loomHostChanges = true;
  setPlanRevisionPort(lumaPlanRevisions);

  onDomainEvent(async (trx, tenantId, e) => {
    let change: ChangeInput | null = null;
    if (e.type === 'stock.moved') change = { type: 'inventory', scope: `item:${e.item_id}`, data: { available: e.available, reorder_level: e.threshold } };
    else if (e.type === 'leave.approved') change = { type: 'capacity', scope: `staff:${e.staff_id}`, data: { from: e.from.toISOString(), to: e.to.toISOString() } };
    else if (e.type === 'service.economics_changed') change = { type: 'margin', scope: `offering:${e.service_id}`, data: { price_before: e.price_before, price_after: e.price_after, cost_before: e.cost_before, cost_after: e.cost_after } };
    if (!change || !(await loomEngaged(trx, tenantId))) return;
    await enqueue(trx, CHANGE_TOPIC, change as unknown as Record<string, unknown>, { tenantId });
  });

  // Never throws: other handlers of booking.confirmed (messaging) must not be retried because of Loom.
  registerOutbox('booking.confirmed', async (ev) => {
    if (!ev.tenantId) return;
    try {
      await withTenant(ev.tenantId, async (trx) => {
        if (!(await loomEngaged(trx, ev.tenantId!))) return;
        const items = await trx.selectFrom('booking_items').select(['service_id', 'starts_at']).where('booking_id', '=', String(ev.payload.booking_id)).where('superseded_at', 'is', null).execute();
        for (const s of new Set(items.map((i) => i.service_id))) {
          await recordChange(trx, ev.tenantId!, { type: 'occupancy', scope: `offering:${s}`, data: { booking_ref: String(ev.payload.booking_id) } });
        }
      });
    } catch (err) {
      console.error('loom: occupancy change not recorded', (err as Error).message);
    }
  });
}
export {};

import type { Tx } from '../db';
import type { MetricContext } from '../metrics/context';
import type { MetricSet } from '../metrics/registry';
import { writeFact } from './facts';

/**
 * Refreshes computed facts (from the connector and metrics) and inferred
 * facts (correctable, never above explicit ones) after each analysis.
 */
export async function refreshDerivedFacts(trx: Tx, businessId: string, ctx: MetricContext, metrics: MetricSet) {
  const { ds } = ctx;
  const computed: Array<[string, unknown, 'connector' | 'metric', string]> = [
    ['identity.sector', ds.business.sector, 'connector', 'business'],
    ['identity.subsector', ds.business.subsector, 'connector', 'business'],
    ['identity.city', ds.business.city, 'connector', 'business'],
    ['identity.locations', ds.locations.filter((l) => l.active).length, 'connector', 'locations'],
    ['resources.staff_active', ds.resources.filter((r) => r.kind === 'staff' && r.active).length, 'connector', 'resources'],
    ['constraints.free_minutes_next14', metrics.value('capacity.free_minutes_next14'), 'metric', 'capacity.free_minutes_next14'],
    ['constraints.low_stock_items', ds.inventory.filter((i) => i.active && i.reorder_level !== null && i.on_hand - i.reserved <= i.reorder_level).length, 'connector', 'inventory_items'],
  ];
  // Preferences already held by the host (LUMA marketing preferences) are computed facts, outranked by explicit Loom settings.
  if (ds.host_preferences) {
    if (ds.host_preferences.max_discount_bp !== null) computed.push(['pref.max_discount_bp', ds.host_preferences.max_discount_bp, 'connector', 'marketing_preferences']);
    if (ds.host_preferences.monthly_budget_minor !== null) computed.push(['pref.monthly_budget_minor', ds.host_preferences.monthly_budget_minor, 'connector', 'marketing_preferences']);
  }
  for (const [key, value, type, ref] of computed) await writeFact(trx, businessId, { key, value, kind: 'computed', source_type: type, source_ref: ref });

  // Inferred: the core audience by acquisition source (only with a sample).
  const mix = metrics.all('customers.acquisition_mix').filter((m) => m.value !== null).sort((a, b) => b.value! - a.value!);
  if (mix[0]) {
    const share = mix[0].value!;
    await writeFact(trx, businessId, { key: 'audience.core', value: `source:${mix[0].grain_ref.split(':')[1]}`, kind: 'inferred', source_type: 'metric', source_ref: 'customers.acquisition_mix',
      confidence: share >= 0.5 && mix[0].n >= 30 ? 'high' : share >= 0.3 ? 'medium' : 'low' });
  }
}

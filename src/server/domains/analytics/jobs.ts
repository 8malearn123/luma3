import { sql, withSystem, withTenant } from '../../db/client';
import { registerJob, registerPeriodic } from '../../jobs/registry';
import { rollupDay } from './metrics';
import { addDays, localToday } from './period';

/**
 * Rolls up yesterday and today (tenant-local days) for one tenant. Idempotent:
 * daily_metrics rows are upserted by (tenant, day, metric, dimension).
 */
export async function rollupTenant(tenantId: string, days?: string[]) {
  return withTenant(tenantId, async (trx) => {
    const t = await trx.selectFrom('tenants').select(['timezone']).where('id', '=', tenantId).executeTakeFirstOrThrow();
    const today = localToday(t.timezone);
    const list = days ?? [addDays(today, -1), today];
    const out = [];
    for (const d of list) out.push(await rollupDay(trx, tenantId, t.timezone, d));
    return out;
  });
}

registerJob('analytics.rollup', async (payload, ctx) => {
  if (!ctx.tenantId) throw new Error('analytics.rollup requires a tenant');
  const days = Array.isArray(payload.days) ? (payload.days as string[]).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).slice(0, 62) : undefined;
  return { days: await rollupTenant(ctx.tenantId, days) };
});

registerPeriodic({
  name: 'analytics.daily-rollup',
  everySec: 3600,
  run: async () => {
    // Fan-out only: list tenants with recent storefront activity; each rollup re-enters withTenant.
    const tenants = await withSystem('analytics rollup fan-out', (trx) => sql<{ tenant_id: string }>`
      select distinct tenant_id from analytics_events where received_at > now() - interval '3 days'`.execute(trx));
    for (const r of tenants.rows) {
      try { await rollupTenant(r.tenant_id); } catch (e) { console.error('[analytics.rollup]', r.tenant_id, (e as Error).message); }
    }
  },
});

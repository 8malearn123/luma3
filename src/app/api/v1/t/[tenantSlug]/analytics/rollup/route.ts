import { z } from 'zod';
import { route } from '@/server/http/route';
import { rollupTenant } from '@/server/domains/analytics/jobs';
import { addDays, localToday } from '@/server/domains/analytics/period';

/** Recomputes the daily series for the last N tenant-local days now (idempotent). */
export const POST = route({
  auth: 'tenant', capability: 'analytics.view', allowReadOnly: true,
  input: z.object({ days: z.number().int().min(1).max(62).default(30) }).strict(),
  rateLimit: { scope: 'user', limit: 10, windowSec: 600, name: 'analytics-rollup' },
  handler: async ({ tenant, input }) => {
    const today = localToday(tenant.timezone);
    const days = Array.from({ length: input.days }, (_, i) => addDays(today, -i)).reverse();
    return { data: { days: (await rollupTenant(tenant.tenantId, days)).length } };
  },
});

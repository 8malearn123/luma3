import { platformRoute } from '@/server/domains/platform/guard';
import { generateStatements, listStatements } from '@/server/domains/settlements/service';
import { csvResponse } from '@/server/domains/platform/export';
import { settlementGenerateInput, settlementListQuery } from '@/shared/schemas/admin';

const COLS = ['tenant_slug', 'tenant_name', 'period_start', 'period_end', 'currency', 'payments_count', 'gross_minor', 'refunds_minor', 'fee_minor', 'net_minor', 'status', 'settled_at', 'settlement_reference', 'fee_source'];

/** GET /api/v1/platform/settlements[?format=csv] — per-tenant settlement statements. */
export const GET = platformRoute({
  platformCapability: 'platform.settlements.manage', input: settlementListQuery,
  handler: async ({ input, actor }) => {
    if (input.format === 'csv') {
      const r = await listStatements({ ...input, page: 1, limit: 10_000 });
      const { format: _f, page: _p, limit: _l, ...filters } = input;
      return csvResponse(actor, 'settlements', 'luma-settlements.csv', r.items, COLS, filters);
    }
    return { data: await listStatements(input) };
  },
});

/** POST /api/v1/platform/settlements — (re)generate simulated statements for a period. */
export const POST = platformRoute({
  platformCapability: 'platform.settlements.manage', input: settlementGenerateInput,
  handler: async ({ input, actor }) => ({ data: await generateStatements(actor, input) }),
});

import { platformRoute } from '@/server/domains/platform/guard';
import { statementDetail, statementHtml } from '@/server/domains/settlements/service';
import { getPlatformSettings } from '@/server/domains/platform/settings';
import { withSystem } from '@/server/db/client';
import { audit } from '@/server/infra/audit';
import { requireUuidParam } from '@/server/http/params';
import { z } from 'zod';

/** GET /api/v1/platform/settlements/:id[?format=html] — statement + payment lines; html is print/PDF-ready. */
export const GET = platformRoute({
  platformCapability: 'platform.settlements.manage', input: z.object({ format: z.enum(['json', 'html']).default('json') }),
  handler: async ({ params, input, actor }) => {
    const d = await statementDetail(requireUuidParam(params, 'id'));
    if (input.format === 'html') {
      await withSystem('platform: audit statement export', (trx) => audit(trx, actor, 'platform.export', { tenantId: d.statement.tenant_id, targetType: 'settlement_statement', targetId: d.statement.id, data: { kind: 'settlement_statement_html' } }));
      return new Response(statementHtml(d, (await getPlatformSettings()).platform_name), { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'" } });
    }
    return { data: d };
  },
});

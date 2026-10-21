import { route } from '@/server/http/route';
import { listTenantAudit } from '@/server/domains/settings/audit';
import { tenantAuditQuery } from '@/shared/schemas/settings';

/** GET /api/v1/t/:slug/audit — the business's own audit log (redacted), support actions flagged. */
export const GET = route({
  auth: 'tenant', capability: 'audit.view', input: tenantAuditQuery,
  handler: async ({ tenant, input }) => ({ data: await listTenantAudit(tenant, input) }),
});

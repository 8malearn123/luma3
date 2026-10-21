import { platformRoute } from '@/server/domains/platform/guard';
import { platformAudit } from '@/server/domains/platform/reports';
import { auditQuery } from '@/shared/schemas/platform';

/** GET /api/v1/platform/audit — search by business/actor/action/date; keyset-paginated. */
export const GET = platformRoute({
  platformCapability: 'platform.audit.view', input: auditQuery,
  handler: async ({ input }) => ({ data: await platformAudit(input) }),
});

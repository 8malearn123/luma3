import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { revealIdNumber } from '@/server/domains/hr/files';

/** POST reveal the full ID/iqama/border number (owner only, audited). */
export const POST = route({
  auth: 'tenant', capability: 'staff_file.manage', allowReadOnly: true,
  rateLimit: { scope: 'user', name: 'hr-reveal', limit: 60, windowSec: 3600 },
  handler: async ({ tenant, actor, params }) => ({ data: await revealIdNumber(tenant, actor, requireUuidParam(params, 'staffId')) }),
});

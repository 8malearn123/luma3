import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { getPlan } from '@/server/domains/marketing/plans';
import { localizePlan } from '@/server/loom-host/plan-view';

/** GET a plan with its versions — Loom versions rendered in the reader's locale, with display labels/units and provenance. */
export const GET = route({
  auth: 'tenant', capability: ['marketing.view', 'marketing.manage'], feature: 'feature.marketing_ai',
  handler: async ({ tenant, params, locale }) => ({ data: await localizePlan(tenant, await getPlan(tenant, requireUuidParam(params, 'id')), locale) }),
});

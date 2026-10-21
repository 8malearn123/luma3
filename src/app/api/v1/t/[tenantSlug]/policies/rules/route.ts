import { route } from '@/server/http/route';
import { createTenantRule, listTenantRules } from '@/server/domains/policy/service';
import { ruleCreate } from '@/shared/schemas/policy';

export const GET = route({
  auth: 'tenant', capability: 'incidents.review',
  handler: async ({ tenant }) => ({ data: await listTenantRules(tenant) }),
});

/** POST — configurable criteria; rules only suggest decisions to a human reviewer. */
export const POST = route({
  auth: 'tenant', capability: 'incidents.review', input: ruleCreate,
  handler: async ({ tenant, actor, input }) => ({ status: 201, data: await createTenantRule(tenant, actor, input) }),
});

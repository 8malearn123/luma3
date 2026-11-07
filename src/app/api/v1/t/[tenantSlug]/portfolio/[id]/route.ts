import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { deletePortfolioItem, updatePortfolioItem } from '@/server/domains/portfolio/service';
import { portfolioItemPatch } from '@/shared/schemas/portfolio';

export const PATCH = route({
  auth: 'tenant', capability: 'builder.edit', input: portfolioItemPatch,
  handler: async ({ tenant, actor, params, input }) => ({ data: await updatePortfolioItem(tenant, actor, requireUuidParam(params, 'id'), input) }),
});
export const DELETE = route({
  auth: 'tenant', capability: 'builder.edit',
  handler: async ({ tenant, actor, params }) => ({ data: await deletePortfolioItem(tenant, actor, requireUuidParam(params, 'id')) }),
});

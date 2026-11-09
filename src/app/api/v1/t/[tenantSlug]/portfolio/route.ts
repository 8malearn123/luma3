import { route } from '@/server/http/route';
import { createPortfolioItem, listPortfolio } from '@/server/domains/portfolio/service';
import { portfolioItemInput } from '@/shared/schemas/portfolio';

/** Portfolio («أعمالي»): before/after pairs shown by the storefront's before/after block. */
export const GET = route({
  auth: 'tenant', capability: 'builder.edit',
  handler: async ({ tenant }) => ({ data: await listPortfolio(tenant.tenantId) }),
});
export const POST = route({
  auth: 'tenant', capability: 'builder.edit', input: portfolioItemInput,
  handler: async ({ tenant, actor, input }) => ({ status: 201, data: await createPortfolioItem(tenant, actor, input) }),
});

import { route } from '@/server/http/route';
import { searchSpaces } from '@/server/domains/hosting/search';
import { searchInput } from '@/shared/schemas/hosting';

/** «احجزي مساحة عمل»: published spaces that are free for the requested time. */
export const GET = route({ auth: 'tenant', capability: 'workspace.book', feature: 'workspace.book', input: searchInput, handler: async ({ tenant, input }) => ({ data: await searchSpaces(tenant, input) }) });

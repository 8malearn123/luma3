import { route } from '@/server/http/route';
import { listTasks } from '@/server/domains/commerce/inventory-tasks';
import { tasksQuery } from '@/shared/schemas/inventory';

export const GET = route({
  auth: 'tenant', capability: ['inventory.view', 'inventory.manage'], feature: 'feature.inventory', input: tasksQuery,
  handler: async ({ tenant, input }) => ({ data: await listTasks(tenant, input) }),
});

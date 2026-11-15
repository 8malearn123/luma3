import { route } from '@/server/http/route';
import { Errors } from '@/server/http/errors';
import { inventoryReport, REPORTS, type ReportKind } from '@/server/domains/commerce/inventory-reports';
import { reportQuery } from '@/shared/schemas/inventory';

/** Inventory & operations reports; advanced ones need feature.inventory_reports_advanced. */
export const GET = route({
  auth: 'tenant', capability: ['inventory.view', 'inventory.manage', 'finance.view'], feature: 'feature.inventory', input: reportQuery,
  handler: async ({ tenant, input, params }) => {
    const kind = params.kind as ReportKind;
    if (!REPORTS.includes(kind)) throw Errors.notFound('report');
    return { data: await inventoryReport(tenant, kind, input) };
  },
});

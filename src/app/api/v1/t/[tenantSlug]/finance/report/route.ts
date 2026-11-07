import { z } from 'zod';
import { route } from '@/server/http/route';
import { financeReport } from '@/server/domains/finance/service';
import { branchScopeFor } from '@/server/domains/business/branch-scope';
import { branchFinance } from '@/server/domains/business/branch-finance';

const d = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** The ledger is business-wide; with a branch selected in the switcher the branch slice is added under `branch`. */
export const GET = route({
  auth: 'tenant', capability: 'finance.view', feature: 'feature.finance_reports', input: z.object({ from: d, to: d, branch_id: z.string().max(40).optional() }),
  handler: async ({ tenant, input, req }) => {
    const report = await financeReport(tenant, input.from, input.to);
    const scope = await branchScopeFor(req, tenant);
    return { data: { ...report, branch: scope.branchIds ? await branchFinance(tenant, input.from, input.to, scope.branchIds) : null } };
  },
});

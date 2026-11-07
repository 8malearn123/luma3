import { platformRoute } from '@/server/domains/platform/guard';
import { platformPayments } from '@/server/domains/platform/activity';
import { csvResponse } from '@/server/domains/platform/export';
import { activityPaymentsQuery } from '@/shared/schemas/admin';

const COLS = ['id', 'tenant_slug', 'tenant_name', 'purpose', 'reference', 'kind', 'method', 'provider', 'status', 'amount_minor', 'refunded_minor', 'currency', 'needs_reconciliation', 'captured_at', 'created_at'];

/** GET /api/v1/platform/activity/payments — read-only payments across businesses (no customer data). */
export const GET = platformRoute({
  platformCapability: 'platform.activity.view', input: activityPaymentsQuery,
  handler: async ({ input, actor }) => {
    if (input.format === 'csv') {
      const r = await platformPayments(input, { all: true });
      const { format: _f, page: _p, limit: _l, ...filters } = input;
      return csvResponse(actor, 'activity.payments', 'luma-payments.csv', r.items, COLS, filters);
    }
    return { data: await platformPayments(input) };
  },
});

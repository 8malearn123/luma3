import { platformRoute } from '@/server/domains/platform/guard';
import { platformReport, reportCsvRows } from '@/server/domains/platform/insights';
import { csvResponse } from '@/server/domains/platform/export';
import { Errors } from '@/server/http/errors';
import { periodQuery, REPORT_KINDS, type ReportKind } from '@/shared/schemas/admin';

/** GET /api/v1/platform/reports/:kind?from&to[&format=csv] — monthly_revenue, vat_summary, provider_performance, bookings. */
export const GET = platformRoute({
  platformCapability: 'platform.analytics.view', input: periodQuery,
  handler: async ({ params, input, actor }) => {
    const kind = params.kind as ReportKind;
    if (!REPORT_KINDS.includes(kind)) throw Errors.notFound('report');
    const r = await platformReport(kind, input);
    if (input.format === 'csv') return csvResponse(actor, `report.${kind}`, `luma-${kind}-${r.period.from}_${r.period.to}.csv`, reportCsvRows(r.rows as Array<Record<string, unknown>>), undefined, r.period);
    return { data: r };
  },
});

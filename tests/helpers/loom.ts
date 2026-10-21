import { withTenant } from '@/server/db/client';
import type { AiProvider, AiRequest } from '@/server/infra/ai';
import { addBooking, addCustomer, addReview, addService, addStaff } from './marketing-data';

type Biz = { tenantId: string; branchId: string };
const DAY = 86_400_000;

/** A business with a schedule, two services (one without cost), customers and completed history. */
export async function seedBusiness(biz: Biz, opts: { serviceName?: string; customers?: number; withCost?: boolean } = {}) {
  const staff = await addStaff(biz, 'Seed Specialist');
  await withTenant(biz.tenantId, async (trx) => {
    await trx.insertInto('working_hours').values(Array.from({ length: 7 }, (_, wd) => ({ tenant_id: biz.tenantId, staff_id: staff, branch_id: biz.branchId, weekday: wd, start_time: '09:00', end_time: '17:00' }))).execute();
  });
  const svcA = await addService(biz, { name: opts.serviceName ?? 'Hair Color', price: 30000, cost: opts.withCost === false ? null : 12000, duration: 90 });
  const svcB = await addService(biz, { name: 'Nail Care', price: 12000, cost: null, duration: 60 });
  const customers: string[] = [];
  const n = opts.customers ?? 6;
  for (let i = 0; i < n; i++) customers.push(await addCustomer(biz, { name: `Private Person ${i}`, phone: `+96655000${1000 + i}`, email: `private${i}@example.test`, tags: ['seed'] }));
  // Completed visits every ~20 days for each customer on service A, plus B for some.
  for (const [i, c] of customers.entries()) {
    for (const k of [80, 60, 40]) {
      const b = await addBooking(biz, { customerId: c, serviceId: svcA, staffId: staff, startsAt: new Date(Date.now() - (k + i) * DAY), durationMin: 90, price: 30000 });
      if (k === 40) await addReview(biz, b, c, 5, staff);
    }
    if (i % 2 === 0) await addBooking(biz, { customerId: c, serviceId: svcB, staffId: staff, startsAt: new Date(Date.now() - (30 + i) * DAY), durationMin: 60, price: 12000 });
  }
  return { staff, svcA, svcB, customers };
}

export type Captured = { requests: AiRequest[] };

/** Fake provider that captures requests and answers with `respond(input)`. */
export function fakeProvider(respond: (req: AiRequest) => unknown, cap: Captured = { requests: [] }): AiProvider & { cap: Captured } {
  return {
    name: 'fake', model: 'fake-model-1', cap,
    generate: async (req) => {
      cap.requests.push(req);
      return { output: respond(req), usage: { inputTokens: 100, outputTokens: 50 }, latencyMs: 2, provider: 'fake', model: 'fake-model-1' };
    },
  };
}

type Metrics = Record<string, { value: number | null }>;
export const metricsOf = (req: AiRequest) => (req.input as { metrics: Metrics }).metrics;

export function validRec(req: AiRequest, over: Record<string, unknown> = {}) {
  const m = metricsOf(req);
  const key = 'bookings.completed_90d';
  return {
    title: 'Bring back regulars', category: 'reactivation', horizon: 'weekly', evidence_refs: [key], measured_metrics: [{ key, value: m[key]!.value }],
    service_refs: [], opportunity: `There were ${m[key]!.value} completed bookings in 90 days.`, suggested_action: 'Send a friendly reminder to consenting customers.',
    timing: 'Next week', estimated_cost: { status: 'unknown', amount_minor: null, assumptions: 'n/a' }, discount_bp: null, claims_profitable: false,
    channel: 'in_app', draft_text: 'We miss you', prerequisites: [], success_metric: 'Completed bookings', experiment_design: 'Holdout 10%', confidence: 'medium',
    limitations: 'Small sample', proposed_target: null, forecast: null, ...over,
  };
}

export function validPlanOutput(req: AiRequest, recs: unknown[] = [validRec(req)]) {
  const period = (req.input as { plan_period: { from: string; to: string } }).plan_period;
  return {
    plan: {
      title: 'AI plan', goal: 'Fill quiet periods', initiatives: [{ id: 'i1', title: 'Reactivation', description: 'Remind regulars', evidence_refs: ['bookings.completed_90d', 'made.up.key'] }],
      activities: [{ id: 'a1', title: 'Reminder', initiative_id: 'i1', date_from: period.from, date_to: period.to, channel: 'in_app', content_idea: 'We miss you', monthly_goal_ref: null }],
      metrics: [{ key: 'capacity.past28.occupancy', label: 'Occupancy', proposed_target: 0.7 }], limitations: 'Model output',
    },
    recommendations: recs,
  };
}

/**
 * Tests run marketing jobs directly; cancel the job_runs rows they queued so
 * other suites' runDueJobs() calls are not crowded out by leftovers.
 */
export async function cancelLeftoverMarketingJobs() {
  const { withSystem } = await import('@/server/db/client');
  await withSystem('test cleanup', (trx) => trx.updateTable('job_runs').set({ status: 'cancelled' })
    .where('status', '=', 'queued').where('kind', 'in', ['marketing.ai_job', 'marketing.campaign_send', 'marketing.trend_fetch', 'analytics.rollup']).execute());
}

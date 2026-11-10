import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { sql, withSystem, withTenant } from '@/server/db/client';
import { analyzeNow, generatePlanNow, proposePlanRevision, loomPlannerApi, type PlanDraft } from '@/loom';
import '@/server/loom-host/planner-port';
import { AiError, setAiProviderForTests } from '@/server/infra/ai';
import * as transition from '@/app/api/v1/t/[tenantSlug]/marketing/plans/[id]/transition/route';
import * as planOne from '@/app/api/v1/t/[tenantSlug]/marketing/plans/[id]/route';
import { localToday, monthBounds } from '@/server/domains/analytics/period';
import { cancelLeftoverMarketingJobs, fakeProvider } from '../helpers/loom';
import { loomSalon, materialRecipe } from '../helpers/loom-core';
import { plannerInputOf, validOutput } from '../helpers/loom-planner';

afterEach(() => setAiProviderForTests(undefined));
afterAll(async () => {
  await cancelLeftoverMarketingJobs();
  await withSystem('test cleanup', (trx) => trx.updateTable('job_runs').set({ status: 'cancelled' }).where('status', '=', 'queued').where('kind', 'in', ['loom.analysis', 'loom.plan']).execute());
});

async function analysed(opts: Parameters<typeof loomSalon>[0] = {}) {
  const s = await loomSalon({ consents: true, ...opts });
  const r = await analyzeNow(s.biz.tenantId);
  expect(r?.status).toBe('succeeded');
  return s;
}
const ownerId = async (tenantId: string) => (await withSystem('t', (trx) => trx.selectFrom('tenant_memberships').select('user_id').where('tenant_id', '=', tenantId).where('role', '=', 'owner').executeTakeFirstOrThrow())).user_id;
const actionsOf = (tenantId: string, versionId: string) => withTenant(tenantId, (trx) => trx.selectFrom('loom.plan_actions').selectAll().where('plan_version_id', '=', versionId).orderBy('seq').execute());
const planRow = (tenantId: string, id: string) => withTenant(tenantId, (trx) => trx.selectFrom('marketing_plans').selectAll().where('id', '=', id).executeTakeFirstOrThrow());

function expectContract(d: PlanDraft) {
  expect(d.actions.length).toBeGreaterThan(0);
  for (const a of d.actions) {
    expect(a.ref).toMatch(/^la_\d+$/);
    expect(a.operational.capacity.status).toBeTruthy();
    expect(a.operational.inventory.status).toBeTruthy();
    expect(a.schedule.from <= a.schedule.to).toBe(true);
    expect(a.owner.ar && a.owner.en).toBeTruthy();
    expect(a.success_metrics.length).toBeGreaterThan(0);
  }
  expect(d.baseline.map((b) => b.metric_key)).toContain('sales.completed_count');
  expect(d.review_at > d.period.from || d.review_at > '2000-01-01').toBe(true);
}

describe('Loom planner — rules fallback (T9)', () => {
  it('AI unavailable ⇒ a rules plan with the same contract and an honest note; previous plans stay intact', async () => {
    setAiProviderForTests(null);
    const s = await analysed();
    const r1 = await generatePlanNow(s.biz.tenantId, { kind: 'monthly', requestedBy: await ownerId(s.biz.tenantId) });
    expect(r1).toMatchObject({ status: 'succeeded', source: 'rules', ai_reason: 'ai_disconnected' });
    expectContract(r1!.draft!);
    expect(r1!.draft!.notes.map((n) => n.en).join(' ')).toMatch(/AI is not connected/);
    const rows = await actionsOf(s.biz.tenantId, r1!.plan_version_id!);
    expect(rows.length).toBe(r1!.draft!.actions.length);
    expect(rows.every((x) => x.opportunity_id)).toBe(true);

    // Approve v1, then a failing provider: the plan gets a new rules version, v1 stays approved.
    const ap = await s.owner.call(transition.POST, { params: { ...s.p, id: r1!.plan_id! }, body: { action: 'approve' } });
    expect(ap.status).toBe(200);
    setAiProviderForTests(fakeProvider(() => { throw new AiError('timeout', 'slow', true); }));
    const r2 = await generatePlanNow(s.biz.tenantId, { kind: 'monthly' });
    expect(r2).toMatchObject({ source: 'rules', ai_reason: 'ai_failed', plan_id: r1!.plan_id });
    const plan = await planRow(s.biz.tenantId, r1!.plan_id!);
    expect(plan.approved_version_id).toBe(r1!.plan_version_id);
    expect(plan.current_version_id).toBe(r2!.plan_version_id);
    const view = await s.owner.call(planOne.GET, { params: { ...s.p, id: r1!.plan_id! } });
    expect(view.body.data.versions.map((v: any) => v.source)).toEqual(['rules', 'rules']);
    expect(view.body.data.versions[0].content.limitations).toMatch(/موثوقة|reliable/);
    expect(view.body.data.has_unapproved_changes).toBe(true);
  });

  it('budget exhausted ⇒ rules plan without calling the model', async () => {
    const s = await analysed();
    const cap = { requests: [] as unknown[] };
    setAiProviderForTests(fakeProvider((req) => validOutput(req), cap as never));
    const month = monthBounds(localToday('Asia/Riyadh')).from;
    await withTenant(s.biz.tenantId, (trx) => trx.insertInto('usage_counters').values({ tenant_id: s.biz.tenantId, metric: 'ai_runs', period_start: month, value: 1_000_000 })
      .onConflict((oc) => oc.columns(['tenant_id', 'metric', 'period_start']).doUpdateSet({ value: 1_000_000 })).execute());
    const r = await generatePlanNow(s.biz.tenantId, { kind: 'monthly' });
    expect(r).toMatchObject({ source: 'rules', ai_reason: 'ai_budget_exhausted' });
    expect(cap.requests).toHaveLength(0);
  });

  it('no analysis ⇒ insufficient_data, nothing stored', async () => {
    const s = await loomSalon();
    const r = await generatePlanNow(s.biz.tenantId, { kind: 'monthly' });
    expect(r).toMatchObject({ status: 'insufficient_data', plan_id: null });
  });
});

describe('Loom planner — AI wording with validation', () => {
  it('uses validated AI wording, provenance, model tier, citations; the card shows it', async () => {
    const s = await analysed();
    const p = fakeProvider((req) => validOutput(req));
    setAiProviderForTests(p);
    const r = await generatePlanNow(s.biz.tenantId, { kind: 'monthly' });
    expect(r).toMatchObject({ status: 'succeeded', source: 'ai', ai_reason: null });
    expect(r!.validation.status).toBe('valid');
    expect(p.cap.requests).toHaveLength(1);
    const req = p.cap.requests[0]!;
    expect(req.promptKey).toBe('loom.planner.monthly');
    // Redacted input: no customer names, phones, e-mails or ids.
    expect(JSON.stringify(req.input)).not.toMatch(/Private Name|\+96655|example\.test/);
    for (const c of s.customers) expect(JSON.stringify(req.input)).not.toContain(c);
    const pv = await withSystem('t', (trx) => trx.selectFrom('prompt_versions').select(['model_tier']).where('key', '=', 'loom.planner.monthly').executeTakeFirstOrThrow());
    expect(pv.model_tier).toBe('strong');
    const run = await withTenant(s.biz.tenantId, (trx) => trx.selectFrom('ai_runs').select(['prompt_key', 'status', 'cache_key']).where('tenant_id', '=', s.biz.tenantId).execute());
    expect(run.some((x) => x.prompt_key === 'loom.planner.monthly' && x.status === 'succeeded' && x.cache_key)).toBe(true);
    expect(r!.draft!.title.en).toBe('Proposed monthly plan');
    const opps = await withTenant(s.biz.tenantId, (trx) => trx.selectFrom('loom.opportunities').select(['id', 'wording']).where('wording', 'is not', null).execute());
    expect(opps.length).toBeGreaterThan(0);
    const cites = await withTenant(s.biz.tenantId, (trx) => trx.selectFrom('loom.knowledge_citations').selectAll().execute());
    expect(cites.some((c) => c.used_by === 'planner_ai')).toBe(true);
    const list = await import('@/loom').then((m) => m.loomApi.listOpportunities({ businessId: s.biz.tenantId, locale: 'en' }, {} as never));
    const worded = list.find((o) => o.card.title === 'AI wording for a proven opportunity');
    expect(worded).toBeTruthy();
    expect(worded!.card.knowledge_refs.length).toBeGreaterThan(0);
    expect(worded!.details.wording?.source).toBe('ai');
  });

  it('re-asks once on an unsupported number (T14), then falls back to rules wording for what is still invalid', async () => {
    const s = await analysed();
    let n = 0;
    const p = fakeProvider((req) => {
      n++;
      const bad = { why_now: { ar: 'زيادة متوقعة 37% هذا الشهر', en: 'An expected 37% rise this month' }, numbers: [] };
      // First answer: unsupported number on every card. Second: fixed except the first card.
      return validOutput(req, { card: (o) => (n === 1 || o.ref === 'O1' ? bad : {}) });
    });
    setAiProviderForTests(p);
    const r = await generatePlanNow(s.biz.tenantId, { kind: 'monthly' });
    expect(p.cap.requests).toHaveLength(2);
    expect((p.cap.requests[1]!.input as any).validation_errors.some((e: any) => e.code === 'unsupported_number')).toBe(true);
    expect(r!.validation).toMatchObject({ reasked: true, status: 'partially_rules' });
    expect(r!.validation.rules_fallback).toEqual(['O1']);
    const texts = JSON.stringify(r!.draft!.actions.map((a) => a.title));
    expect(texts).not.toMatch(/37/);
  });

  it('answers bounded read tools scoped to the business, citable as tr_*', async () => {
    const s = await analysed();
    const p = fakeProvider((req) => {
      const inp = plannerInputOf(req);
      if (!inp.tool_results) return validOutput(req, { tools: [
        { tool: 'get_metric', metric_key: 'sales.completed_count', grain_ref: 'business', offering_ref: null, segment: null, window: null },
        { tool: 'get_capacity', metric_key: null, grain_ref: null, offering_ref: 'O1', segment: null, window: null },
        { tool: 'get_segment_size', metric_key: null, grain_ref: null, offering_ref: null, segment: { conditions: [{ type: 'visited_offering', offering_ref: 'O1', days: null }] }, window: null },
      ] });
      const tr = inp.tool_results.find((t) => t.id === 'tr_1')!;
      return validOutput(req, { card: (o) => (o.ref === 'O1' ? { why_now: { ar: `المبيعات المكتملة ${tr.value}`, en: `Completed sales ${tr.value}` }, numbers: [{ value: tr.value, evidence_ref: 'tr_1', assumption: false }] } : {}) });
    });
    setAiProviderForTests(p);
    const r = await generatePlanNow(s.biz.tenantId, { kind: 'monthly' });
    expect(p.cap.requests).toHaveLength(2);
    const results = (p.cap.requests[1]!.input as any).tool_results;
    expect(results).toHaveLength(3); // at most 3 calls (schema + runTools)
    expect(results[0]).toMatchObject({ id: 'tr_1', status: 'ok', value: 30 });
    expect(r!.validation).toMatchObject({ status: 'valid', tool_calls: 3 });
  });

  it('a budget overflow proposed by the model rejects the plan head and keeps the rules budget', async () => {
    const s = await analysed();
    await withTenant(s.biz.tenantId, (trx) => sql`select 1`.execute(trx));
    const { loomApi } = await import('@/loom');
    await loomApi.putSetup({ businessId: s.biz.tenantId, actor: { userId: await ownerId(s.biz.tenantId), kind: 'user' }, locale: 'en' }, { monthly_budget_minor: 10000 } as never);
    setAiProviderForTests(fakeProvider((req) => validOutput(req, { budget: 50_000 })));
    const r = await generatePlanNow(s.biz.tenantId, { kind: 'monthly' });
    expect(r!.source).toBe('ai');
    expect((r!.validation.errors as any[]).some((e) => e.code === 'budget_overflow')).toBe(true);
    const total = r!.draft!.actions.reduce((x, a) => x + (a.budget.amount_minor ?? 0), 0);
    expect(total).toBeLessThanOrEqual(10000);
    expect(r!.draft!.title.en).not.toBe('Proposed monthly plan');
  });

  it('the planner cache is scoped to the business (T12)', async () => {
    const a = await analysed({ name: 'Cache A' });
    const b = await analysed({ name: 'Cache B' });
    const p = fakeProvider((req) => validOutput(req));
    setAiProviderForTests(p);
    await generatePlanNow(a.biz.tenantId, { kind: 'monthly' });
    expect(p.cap.requests).toHaveLength(1);
    await generatePlanNow(a.biz.tenantId, { kind: 'monthly' });
    expect(p.cap.requests).toHaveLength(1); // same business, same candidates ⇒ cache hit
    await generatePlanNow(b.biz.tenantId, { kind: 'monthly' });
    expect(p.cap.requests).toHaveLength(2); // another business never reads A's cache
    const leaked = await withTenant(b.biz.tenantId, (trx) => trx.selectFrom('ai_runs').select('id').where('tenant_id', '=', a.biz.tenantId).execute());
    expect(leaked).toHaveLength(0);
  });
});

describe('Loom plans — weekly plan, revisions (T10)', () => {
  it('weekly plan highlights offerings with real free slots and their materials', async () => {
    const s = await analysed();
    await materialRecipe(s.biz, s.s2, { onHand: 500, perService: 10 });
    await analyzeNow(s.biz.tenantId);
    setAiProviderForTests(null);
    const r = await generatePlanNow(s.biz.tenantId, { kind: 'weekly' });
    expect(r).toMatchObject({ status: 'succeeded', source: 'rules' });
    const hl = r!.draft!.actions.flatMap((a) => a.highlighted);
    expect(hl.length).toBeGreaterThan(0);
    for (const h of hl) { expect(h.free_slots).toBeGreaterThan(0); expect(h.sample_slots.length).toBeGreaterThan(0); }
    const withMat = hl.find((h) => h.offering_id === s.s2);
    expect(withMat!.materials[0]).toMatchObject({ name: 'Facial serum', per_service: 10, available: 500 });
  });

  it('a material change after approval yields a proposed revision; the approved version never changes', async () => {
    setAiProviderForTests(null);
    const s = await analysed();
    const r = await generatePlanNow(s.biz.tenantId, { kind: 'monthly' });
    await s.owner.call(transition.POST, { params: { ...s.p, id: r!.plan_id! }, body: { action: 'approve' } });
    const before = await planRow(s.biz.tenantId, r!.plan_id!);
    const rev = await proposePlanRevision(s.biz.tenantId, r!.plan_id!, { ar: 'نفدت مادة السيروم', en: 'The serum ran out' }, [
      { kind: 'pause_action', action_ref: 'la_1', note: { ar: 'نفاد المادة', en: 'Material out of stock' } },
    ]);
    expect(rev.status).toBe('proposed');
    const after = await planRow(s.biz.tenantId, r!.plan_id!);
    expect(after.approved_version_id).toBe(before.approved_version_id);
    expect(after.current_version_id).not.toBe(before.current_version_id);
    const v = await withTenant(s.biz.tenantId, (trx) => trx.selectFrom('plan_versions').selectAll().where('id', '=', after.current_version_id!).executeTakeFirstOrThrow());
    expect(v.change_note).toMatch(/serum ran out/);
    expect((v.validation as any).status).toBe('revision_proposed');
    const acts = await actionsOf(s.biz.tenantId, after.current_version_id!);
    expect((acts[0]!.revision_note as any).en).toBe('Material out of stock');
    // The approved version's actions are untouched.
    const old = await actionsOf(s.biz.tenantId, before.approved_version_id!);
    expect(old[0]!.revision_note).toBeNull();
    const home = await loomPlannerApi.home({ businessId: s.biz.tenantId, locale: 'en' }, localToday('Asia/Riyadh'));
    expect(home.pending.plan_revisions.map((x) => x.id)).toContain(r!.plan_id);
    expect(home.pending.plan_revisions[0]!.reason).toMatch(/serum ran out/);
    // No effect ⇒ nothing is proposed.
    expect(await proposePlanRevision(s.biz.tenantId, r!.plan_id!, 'x', [{ kind: 'remove_action', action_ref: 'la_99', note: { ar: 'x', en: 'x' } }])).toEqual({ status: 'skipped', reason: 'no_effect' });
  });
});

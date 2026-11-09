import { PlannerAiError, registerLoomHost, type HostPlanRef, type LoomHost, type PlanDraft, type PlanKind } from '@/loom';
import { sql, withTenant, type Tx } from '../db/client';
import { AiError, aiProvider, digest, runAi } from '../infra/ai';
import { loadEntitlements } from '../tenancy/access';
import { localToday, monthBounds } from '../domains/analytics/period';
import { consumeAiBudget } from '../domains/marketing/pipeline';
import { jsonSchemaOf } from '../domains/marketing/prompts';
import { appendVersion, saveGeneratedPlan } from '../domains/marketing/plans';
import type { PlanContent } from '@/shared/schemas/marketing';

/**
 * LUMA's implementation of the Loom planner host ports (docs/LOOM_CORE.md §10).
 *  - ai: runAi (strict JSON schema, tenant-scoped cache, ai_runs provenance),
 *    prompt_versions registration with model_tier, and the atomic monthly
 *    AI budget (limit.ai_runs_monthly in usage_counters).
 *  - plans: marketing_plans / plan_versions through the marketing domain
 *    (append-only versions; approval is never touched here).
 * Imported for its side effect by the job index and by the Loom routes.
 */
const pick = (t: { ar: string; en: string } | null | undefined, l: 'ar' | 'en') => (t ? (l === 'ar' ? t.ar || t.en : t.en || t.ar) : '');
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Renders the bilingual Loom plan into LUMA's PlanContent (tenant locale). Structured actions stay in loom.plan_actions. */
export function toPlanContent(d: PlanDraft, l: 'ar' | 'en'): PlanContent {
  const capNote = (a: PlanDraft['actions'][number]) => cut([
    pick(a.operational.capacity.note, l),
    a.operational.inventory.note ? pick(a.operational.inventory.note, l) : '',
    ...a.highlighted.map((h) => `${pick(h.name, l)}: ${h.free_slots ?? '—'} ${l === 'ar' ? 'موعدًا متاحًا' : 'free slots'}`),
    ...a.operational.requirements.map((r) => pick(r, l)),
  ].filter(Boolean).join(' · '), 300);
  return {
    goal: cut(pick(d.goal, l) || pick(d.title, l), 500),
    baseline: d.baseline.slice(0, 30).map((b) => ({ metric_key: b.metric_key.slice(0, 120), label: cut(pick(b.label, l), 200), value: b.value })),
    initiatives: d.actions.slice(0, 20).map((a) => ({ id: a.ref, title: cut(pick(a.title, l), 200) || a.ref, description: cut(pick(a.description, l), 1500), evidence_refs: a.evidence_refs.slice(0, 20) })),
    activities: d.actions.slice(0, 60).map((a) => ({
      id: a.ref, title: cut(pick(a.title, l), 200) || a.ref, initiative_id: a.ref, date_from: a.schedule.from || null, date_to: a.schedule.to || null, channel: a.channels[0] ?? null,
      content_idea: a.content_idea ? cut(pick(a.content_idea, l), 1000) : null, owner: cut(pick(a.owner, l), 80), capacity_note: capNote(a) || null, monthly_goal_ref: null,
      status: 'planned' as const,
    })),
    dates: { start: d.period.from, end: d.period.to },
    owner: '',
    budget: { amount_minor: d.budget.total_minor, status: d.budget.status, assumptions: '' },
    metrics: d.success_metrics.slice(0, 20).map((m) => ({ key: m.metric_key.slice(0, 120), label: cut(pick(m.label, l), 200), baseline: m.baseline, proposed_target: m.proposed_target })),
    monthly_goals: d.goals.slice(0, 10).map((g) => ({ id: g.id.slice(0, 40), title: cut(pick(g.title, l), 200) })),
    experimental: d.experimental,
    limitations: cut([...d.notes, ...d.limitations].map((x) => pick(x, l)).join('\n'), 2000),
  };
}

type PlanRow = { id: string; kind: string; title: string; status: string; period_start: string; period_end: string; is_example: boolean; current_version_id: string | null; approved_version_id: string | null; version: number | null; source: string | null; change_note: string | null };
const ref = (p: PlanRow): HostPlanRef => ({
  plan_id: p.id, kind: p.kind as PlanKind, title: p.title, status: p.status, period: { from: p.period_start, to: p.period_end }, is_example: p.is_example,
  current_version_id: p.current_version_id, current_version: p.version, approved_version_id: p.approved_version_id, current_source: p.source, current_change_note: p.change_note,
  has_unapproved_changes: !!p.approved_version_id && p.approved_version_id !== p.current_version_id,
});
const planQuery = (trx: Tx, businessId: string) => trx.selectFrom('marketing_plans as p').leftJoin('plan_versions as v', 'v.id', 'p.current_version_id')
  .select(['p.id', 'p.kind', 'p.title', 'p.status', 'p.period_start', 'p.period_end', 'p.is_example', 'p.current_version_id', 'p.approved_version_id', 'v.version', 'v.source', 'v.change_note'])
  .where('p.tenant_id', '=', businessId);

export const lumaLoomHost: LoomHost = {
  ai: {
    available: () => !!aiProvider(),
    async consumeBudget(businessId) {
      return withTenant(businessId, async (trx) => {
        const ent = await loadEntitlements(trx, businessId);
        const f = ent.features.get('limit.ai_runs_monthly');
        if (!f || !f.enabled) return false;
        const t = await trx.selectFrom('tenants').select('timezone').where('id', '=', businessId).executeTakeFirstOrThrow();
        return consumeAiBudget(trx, businessId, f.limit, monthBounds(localToday(t.timezone)).from);
      });
    },
    async run(businessId, call) {
      const p = call.prompt;
      const schema = jsonSchemaOf(call.output);
      await withTenant(businessId, (trx) => trx.insertInto('prompt_versions').values({ key: p.key, version: p.version, description: p.description, output_schema: JSON.stringify(schema), model_tier: p.modelTier })
        .onConflict((oc) => oc.columns(['key', 'version']).doNothing()).execute());
      try {
        return await runAi({
          tenantId: businessId, modelTier: p.modelTier,
          request: { promptKey: p.key, promptVersion: p.version, system: p.system, input: call.input, jsonSchema: schema, schemaName: p.schemaName, maxOutputTokens: call.maxOutputTokens ?? 6000 },
          validator: call.output, inputSummary: call.inputSummary,
          // Tenant + prompt + version + candidates/snapshot hash (+ model, filtered inside runAi): never shared across businesses.
          cacheKey: call.cacheParts ? digest({ tenant: businessId, prompt: p.key, version: p.version, parts: call.cacheParts }) : undefined,
        });
      } catch (e) {
        if (e instanceof AiError) throw new PlannerAiError(e.kind, e.message);
        throw e;
      }
    },
  },
  plans: {
    async current(businessId, kind, date) {
      const r = await withTenant(businessId, (trx) => planQuery(trx, businessId).where('p.kind', '=', kind).where('p.is_example', '=', false).where('p.status', 'not in', ['rejected', 'completed'])
        .where('p.period_start', '<=', date).where('p.period_end', '>=', date).orderBy(sql`case p.status when 'in_progress' then 0 when 'approved' then 1 else 2 end`).orderBy('p.created_at', 'desc').executeTakeFirst());
      return r ? ref(r) : null;
    },
    async get(businessId, planId) {
      const r = await withTenant(businessId, (trx) => planQuery(trx, businessId).where('p.id', '=', planId).executeTakeFirst());
      return r ? ref(r) : null;
    },
    async pendingRevisions(businessId) {
      const rows = await withTenant(businessId, (trx) => planQuery(trx, businessId).where('p.is_example', '=', false).where('p.status', 'not in', ['rejected', 'completed'])
        .where('p.approved_version_id', 'is not', null).whereRef('p.approved_version_id', '!=', 'p.current_version_id').orderBy('p.updated_at', 'desc').limit(10).execute());
      return rows.map(ref);
    },
    async saveVersion(businessId, v) {
      return withTenant(businessId, async (trx) => {
        const t = await trx.selectFrom('tenants').select('default_locale').where('id', '=', businessId).executeTakeFirstOrThrow();
        const l = t.default_locale === 'en' ? 'en' : 'ar';
        const content = toPlanContent(v.draft, l);
        const source = v.draft.source === 'ai' ? 'ai' : 'rules';
        if (v.planId) {
          const ver = await appendVersion(trx, businessId, v.planId, { content, source, createdBy: v.createdBy ?? null, aiRunId: v.aiRunId ?? null, validation: v.validation, changeNote: v.changeNote ?? null });
          return { plan_id: v.planId, version_id: ver.id, version: ver.version, created: false };
        }
        const r = await saveGeneratedPlan(trx, businessId, {
          kind: v.draft.kind, from: v.draft.period.from, to: v.draft.period.to, title: cut(pick(v.draft.title, l), 200), content, source,
          parentPlanId: v.parentPlanId ?? null, aiRunId: v.aiRunId ?? null, validation: v.validation, createdBy: v.createdBy ?? null,
        });
        return { plan_id: r.plan_id, version_id: r.version_id, version: r.version, created: r.created };
      });
    },
  },
};

registerLoomHost(lumaLoomHost);

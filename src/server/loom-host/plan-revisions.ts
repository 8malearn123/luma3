import type { ApprovedPlanRef, PlanRevisionChange, PlanRevisionPort, PlanRevisionReason, PlanRevisionResult } from '@/loom';
import { withTenant } from '../db/client';
import { appendVersion } from '../domains/marketing/plans';
import type { PlanContent } from '@/shared/schemas/marketing';

/**
 * Default PlanRevisionPort for LUMA (phase 5). Proposes a revision of an
 * APPROVED marketing plan by APPENDING an unapproved plan_versions row built
 * from the approved content (T10): the approved version and
 * approved_version_id never change; the owner reviews the new version in the
 * plans tab (has_unapproved_changes) and approves it or not.
 *
 * INTEGRATION POINT (phase 3, branch loom-planner): the planner adds
 * `proposePlanRevision(businessId, planId, reason, changes)` with plan_actions
 * as tables. After it merges, replace `lumaPlanRevisions` below (or the
 * `setPlanRevisionPort(...)` call in ./changes.ts) with an adapter that
 * delegates to it; Loom's change aggregator only sees the port.
 */
const ACTION_NOTE: Record<PlanRevisionChange['action'], { ar: string; en: string }> = {
  pause_promotion: { ar: 'إيقاف الترويج مؤقتًا', en: 'pause the promotion' },
  restock_first: { ar: 'إعادة الطلب قبل الترويج', en: 'reorder before promoting' },
  review: { ar: 'مراجعة', en: 'review' },
  note: { ar: 'ملاحظة', en: 'note' },
};

/** A plan item belongs to a change when it cites the same evidence or carries the same title. */
function matches(item: { title: string; evidence_refs?: string[] }, c: PlanRevisionChange) {
  return (item.evidence_refs ?? []).some((r) => c.evidence_refs.includes(r)) || item.title === c.title.ar || item.title === c.title.en;
}

export function reviseContent(content: PlanContent, reason: PlanRevisionReason, changes: PlanRevisionChange[]): PlanContent {
  const next: PlanContent = structuredClone(content);
  const initiativeIds = new Set(next.initiatives.filter((i) => changes.some((c) => matches(i, c))).map((i) => i.id));
  for (const a of next.activities) {
    const c = changes.find((x) => (a.initiative_id && initiativeIds.has(a.initiative_id)) || matches({ title: a.title }, x));
    if (!c) continue;
    const note = `[لووم] ${reason.text.ar}: ${ACTION_NOTE[c.action].ar} — ${c.note.ar}`;
    a.capacity_note = note.slice(0, 300);
  }
  const line = `[لووم ${new Date().toISOString().slice(0, 10)}] ${reason.text.ar} / ${reason.text.en}: ${changes.map((c) => `${c.title.ar} → ${ACTION_NOTE[c.action].ar}`).join('؛ ')}`;
  next.limitations = `${next.limitations ? `${next.limitations}\n` : ''}${line}`.slice(-2000);
  return next;
}

export const lumaPlanRevisions: PlanRevisionPort = {
  async approvedPlans(businessId: string, planIds: string[]): Promise<ApprovedPlanRef[]> {
    const ids = planIds.filter((x) => /^[0-9a-f-]{36}$/.test(x));
    if (!ids.length) return [];
    return withTenant(businessId, async (trx) => (await trx.selectFrom('marketing_plans as p').innerJoin('plan_versions as v', 'v.id', 'p.approved_version_id')
      .select(['p.id', 'p.approved_version_id', 'v.version']).where('p.tenant_id', '=', businessId).where('p.id', 'in', ids)
      .where('p.status', 'in', ['approved', 'in_progress']).execute()).map((r) => ({ plan_id: r.id, approved_version_id: r.approved_version_id!, approved_version: r.version })));
  },
  async proposePlanRevision(businessId: string, planId: string, reason: PlanRevisionReason, changes: PlanRevisionChange[]): Promise<PlanRevisionResult> {
    return withTenant(businessId, async (trx) => {
      const plan = await trx.selectFrom('marketing_plans as p').innerJoin('plan_versions as v', 'v.id', 'p.approved_version_id').select(['p.id', 'v.content'])
        .where('p.tenant_id', '=', businessId).where('p.id', '=', planId).executeTakeFirstOrThrow();
      const content = reviseContent(plan.content as PlanContent, reason, changes);
      const v = await appendVersion(trx, businessId, planId, {
        content, source: 'rules', createdBy: null, changeNote: `loom_revision:${reason.code}:${reason.signal_id}`.slice(0, 200),
        validation: { loom_revision: { reason, changes: changes.map((c) => ({ opportunity_id: c.opportunity_id, initiative_id: c.initiative_id, check: c.check, status: c.status, action: c.action })) } },
      });
      return { plan_id: planId, version_id: v.id, version: v.version };
    });
  },
};

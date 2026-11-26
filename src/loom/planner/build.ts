import type { ActionKind } from '../contracts/opportunity';
import type { PlanAction, PlanDraft } from '../contracts/plan';
import { knowledgeRef } from '../knowledge/library';
import { metricDefinition } from '../metrics/registry';
import { SETUP_ITEMS } from '../profile/facts';
import { L, type Localized } from '../util/text';
import { addDays } from '../util/time';
import { ensureReviewAt } from '../validator/validate';
import { baselineOf, type PlanningContext, type PlanOpp } from './context';

/**
 * Deterministic plan assembly (§11.2). Structure, numbers, budget, schedule,
 * operational requirements and slots come from code; only the wording comes
 * from the planner (AI, validated) or from these rules. The SAME function
 * builds AI and rules plans, so both have one contract (T9).
 */
export type Wording = {
  title: Localized; why_now: Localized; action_description: Localized; draft_content: Localized | null;
  content_idea: Localized | null; knowledge_refs: string[]; event_ref: string | null;
  budget_minor: number | null; assumptions: number[]; source: 'ai' | 'rules';
};
export type PlanHead = { title: Localized; goal: Localized; limitations: Localized[]; source: 'ai' | 'rules' };

export const GOAL_LABEL: Record<string, Localized> = {
  fill_quiet_times: L('ملء الأوقات الهادئة', 'Fill quiet times'), reactivate_customers: L('إعادة العميلات المنقطعات', 'Bring back lapsed customers'),
  grow_offerings: L('تنمية خدمات محددة', 'Grow selected services'), increase_margin: L('رفع الهامش', 'Increase margin'),
  increase_conversion: L('رفع التحويل', 'Increase conversion'), grow_new_customers: L('عميلات جدد', 'New customers'),
  sell_products: L('بيع المنتجات', 'Sell products'), improve_reviews: L('تحسين التقييمات', 'Improve reviews'),
};

const OWNER: Record<ActionKind, Localized> = {
  content: L('المالكة أو مسؤولة التسويق', 'Owner or marketing lead'), package: L('المالكة', 'Owner'), value_add: L('المالكة', 'Owner'),
  reminder: L('الاستقبال', 'Reception'), open_slots: L('المالكة (الجداول)', 'Owner (schedules)'), booking_ux: L('المالكة', 'Owner'),
  loyalty: L('الاستقبال', 'Reception'), limited_discount: L('المالكة', 'Owner'), price_review: L('المالكة', 'Owner'),
  staffing: L('المالكة (الورديات)', 'Owner (shifts)'), restock: L('مسؤولة المخزون', 'Stock lead'),
};

export const AI_REASON_NOTE: Record<string, Localized> = {
  ai_disconnected: L('الذكاء الاصطناعي غير متصل؛ هذه خطة بالقواعد.', 'AI is not connected; this is a rules-based plan.'),
  ai_budget_exhausted: L('انتهت حصة التحليلات الذكية لهذا الشهر؛ هذه خطة بالقواعد.', 'This month’s AI analyses are used up; this is a rules-based plan.'),
  ai_failed: L('تعذّر الحصول على صياغة موثوقة من الذكاء الاصطناعي؛ هذه خطة بالقواعد.', 'No reliable AI wording could be obtained; this is a rules-based plan.'),
  rules_requested: L('خطة بالقواعد بناءً على طلبك.', 'Rules-based plan, as requested.'),
};

/** Rules wording: the engine's bilingual card text plus the best retrieved playbook. */
export function rulesWording(o: PlanOpp): Wording {
  return {
    title: o.card.title, why_now: o.card.why_now, action_description: o.card.recommended_action.description, draft_content: null,
    content_idea: o.knowledge[0] ? L(`مرجع: ${o.knowledge[0].unit.examples.good[0]!.ar}`, `Reference: ${o.knowledge[0].unit.examples.good[0]!.en}`) : null,
    knowledge_refs: o.knowledge.slice(0, 2).map((k) => knowledgeRef(k.unit)), event_ref: o.card.timing.event_ref, budget_minor: null, assumptions: [], source: 'rules',
  };
}

export function rulesHead(pc: PlanningContext): PlanHead {
  const month = pc.period.from.slice(0, 7);
  const goals = pc.profile.goals.map((g) => GOAL_LABEL[g.kind] ?? L(g.kind, g.kind));
  const goal = goals.length ? L(`الأهداف: ${goals.map((g) => g.ar).join('، ')}`, `Goals: ${goals.map((g) => g.en).join(', ')}`)
    : L('تنفيذ أهم الفرص المثبتة بالأدلة ضمن الطاقة والميزانية.', 'Act on the best evidence-backed opportunities within capacity and budget.');
  return {
    title: pc.kind === 'monthly' ? L(`خطة التسويق لشهر ${month}`, `Marketing plan for ${month}`) : L(`خطة الأسبوع ${pc.period.from}`, `Week plan from ${pc.period.from}`),
    goal, limitations: [], source: 'rules',
  };
}

const PREREQ_KINDS = new Set<ActionKind>(['staffing', 'restock']);

function scheduleFor(pc: PlanningContext, o: PlanOpp, role: PlanAction['role']) {
  if (role === 'prerequisite') return { from: pc.period.from, to: [addDays(pc.period.from, 6), pc.period.to].sort()[0]! };
  const from = o.card.period.from > pc.period.from ? o.card.period.from : pc.period.from;
  const to = o.card.period.to < pc.period.to ? o.card.period.to : pc.period.to;
  return from <= to ? { from, to } : { from: pc.period.from, to: pc.period.to };
}

export function buildPlanDraft(pc: PlanningContext, wording: Map<string, Wording>, head: PlanHead, opts: { source: 'ai' | 'rules'; notes: Localized[] }): PlanDraft {
  const notes = [...opts.notes];
  const limitations: Localized[] = [...head.limitations];
  const actions: PlanAction[] = [];
  for (const o of pc.opps) {
    const w = wording.get(o.ref) ?? rulesWording(o);
    const kind = o.card.recommended_action.kind;
    const role: PlanAction['role'] = o.category === 'capacity_prerequisite' || PREREQ_KINDS.has(kind) ? 'prerequisite' : o.category === 'campaign_learning' ? 'measurement' : 'initiative';
    // Never promote full slots (T4): a promotional action with no free slot in the window is left out with a note.
    if (role === 'initiative' && o.promotional && (o.free_slots === 0 || o.card.capacity_check.status === 'blocked')) {
      notes.push(L(`لم تُدرج «${o.card.title.ar}»: لا مواعيد متاحة في الفترة.`, `“${o.card.title.en}” was left out: no free slots in the period.`));
      continue;
    }
    const seq = actions.length + 1;
    const budget = w.budget_minor !== null ? { amount_minor: w.budget_minor, basis: 'assumption' as const } : { amount_minor: o.card.estimated_cost.amount_minor, basis: o.card.estimated_cost.basis };
    const seg = o.card.target_segment;
    actions.push({
      ref: `la_${seq}`, seq, opportunity_id: o.id, role, action_kind: kind, intervention_id: o.card.recommended_action.intervention_id,
      title: w.title, description: w.action_description, content_idea: w.content_idea ?? w.draft_content,
      audience: {
        definition: seg.definition as Record<string, unknown>, size: seg.size, size_status: seg.size_status,
        label: seg.size_status === 'counted' && seg.size !== null ? L(`${seg.size} عميلة في الشريحة`, `${seg.size} customers in the segment`) : L('الشريحة غير محسوبة بدقة', 'Segment size not counted'),
      },
      channels: o.card.channel,
      schedule: scheduleFor(pc, o, role),
      owner: OWNER[kind],
      budget,
      operational: {
        capacity: { status: o.card.capacity_check.status, max_additional: o.card.capacity_check.max_additional, note: o.card.capacity_check.note },
        inventory: { status: o.card.inventory_check.status, covers_n: o.card.inventory_check.covers_n, note: o.card.inventory_check.note ?? null },
        requirements: o.card.prerequisites,
      },
      highlighted: pc.kind === 'weekly' && o.highlighted ? [o.highlighted] : [],
      success_metrics: o.card.success_metrics,
      evidence_refs: o.card.evidence_refs,
      knowledge_refs: w.knowledge_refs,
    });
  }

  // Budget: the plan total never exceeds the business budget — drop the lowest-priority costed initiatives (rules trim).
  const budgetMinor = pc.profile.prefs.monthly_budget_minor;
  const cap = budgetMinor === null ? null : pc.kind === 'weekly' ? Math.floor(budgetMinor / 4) : budgetMinor;
  const total = () => actions.reduce((s, a) => s + (a.budget.amount_minor ?? 0), 0);
  if (cap !== null) {
    while (total() > cap) {
      const idx = [...actions.keys()].reverse().find((i) => (actions[i]!.budget.amount_minor ?? 0) > 0 && actions[i]!.role === 'initiative');
      if (idx === undefined) break;
      const [gone] = actions.splice(idx, 1);
      notes.push(L(`حُذفت «${gone!.title.ar}» لأن مجموع الخطة تجاوز الميزانية.`, `“${gone!.title.en}” was removed because the plan exceeded the budget.`));
    }
    actions.forEach((a, i) => { a.seq = i + 1; a.ref = `la_${i + 1}`; });
  }
  const anyKnown = actions.some((a) => a.budget.amount_minor !== null);
  const t = total();

  if (!pc.profile.setup.complete) {
    const names = SETUP_ITEMS.filter((s) => pc.profile.setup.missing.includes(s.id)).map((s) => s.label);
    limitations.push(L(`إعدادات مطلوبة غير مؤكدة: ${names.map((n) => n.ar).join('، ')}.`, `Required settings not confirmed: ${names.map((n) => n.en).join(', ')}.`));
  }
  if (pc.analysis.mode === 'exploratory') limitations.push(L('خطة استكشافية: البيانات قليلة؛ تجارب محدودة فقط.', 'Exploratory plan: little data; limited trials only.'));
  limitations.push(L('الأهداف المقترحة أهداف للنقاش وليست وعودًا أو توقعات.', 'Proposed targets are goals for discussion, not promises or forecasts.'));

  // Plan-level success metrics are proposed goals only; forecasts stay on their actions, labelled (phase 6, never mixed).
  const goals = actions.flatMap((a) => a.success_metrics.filter((m) => m.target_kind === 'proposed_goal'));
  const metricKeys = [...new Set(goals.map((m) => m.metric_key))];
  const sm = metricKeys.map((k) => {
    const m = goals.find((x) => x.metric_key === k)!;
    return { metric_key: k, label: metricDefinition(k)?.label ?? L(k, k), baseline: m.baseline, proposed_target: m.target };
  });

  return {
    kind: pc.kind, period: pc.period, title: head.title, goal: head.goal,
    goals: pc.profile.goals.map((g) => ({ id: g.id, kind: g.kind, title: GOAL_LABEL[g.kind] ?? L(g.kind, g.kind) })),
    baseline: baselineOf(pc), actions,
    budget: { total_minor: anyKnown ? t : null, business_budget_minor: cap, status: cap === null ? 'no_budget_set' : !anyKnown ? 'unknown' : t <= cap ? 'within_budget' : 'over_budget' },
    success_metrics: sm, limitations: dedupe(limitations), notes: dedupe(notes), source: opts.source,
    experimental: pc.analysis.mode === 'exploratory', review_at: ensureReviewAt(addDays(pc.today, 14), pc.today),
  };
}

function dedupe(xs: Localized[]) {
  const seen = new Set<string>();
  return xs.filter((x) => (seen.has(x.en) ? false : (seen.add(x.en), true)));
}

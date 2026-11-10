import type { AiRequest } from '@/server/infra/ai';

/**
 * Fake planner answers built from the planner input (no network). `valid`
 * produces a fully valid output: number-free text except one traced number,
 * checks copied, knowledge refs from the given snippets.
 */
type Inp = {
  opportunities: Array<{ ref: string; promotional: boolean; checks: { capacity: string; inventory: string; margin: string }; evidence: Array<{ id: string; value: number | null }>; knowledge: Array<{ ref: string }>; free_slots_in_period: number | null }>;
  tool_results?: Array<{ id: string; value: number | null }>;
  validation_errors?: unknown[];
};
export const plannerInputOf = (req: AiRequest) => req.input as unknown as Inp;

export function validCard(o: Inp['opportunities'][number], over: Record<string, unknown> = {}) {
  const ev = o.evidence.find((e) => e.value !== null && Number.isInteger(e.value) && e.value > 1);
  return {
    opportunity_ref: o.ref,
    title: { ar: 'صياغة ذكية لفرصة مثبتة', en: 'AI wording for a proven opportunity' },
    why_now: ev ? { ar: `الأدلة تُظهر ${ev.value} في الفترة الأخيرة`, en: `The evidence shows ${ev.value} in the recent period` } : { ar: 'الأدلة تدعم هذه الخطوة الآن', en: 'The evidence supports this step now' },
    action_description: { ar: 'رسالة ودية للعميلات الموافقات مع رابط حجز مباشر', en: 'A friendly message to consenting customers with a direct booking link' },
    draft_content: { ar: 'عندنا وقت مناسب لك هذا الأسبوع، احجزي بضغطة', en: 'We have a good time for you this week, book in one tap' },
    numbers: ev ? [{ value: ev.value, evidence_ref: ev.id, assumption: false }] : [],
    checks_acknowledged: o.checks,
    knowledge_refs: o.knowledge.slice(0, 1).map((k) => k.ref),
    event_ref: null,
    ...over,
  };
}

export function validOutput(req: AiRequest, opts: { card?: (o: Inp['opportunities'][number]) => Record<string, unknown>; plan?: Record<string, unknown>; tools?: unknown[]; budget?: number | null } = {}) {
  const inp = plannerInputOf(req);
  return {
    tool_requests: opts.tools ?? [],
    cards: inp.opportunities.map((o) => validCard(o, opts.card?.(o) ?? {})),
    plan: {
      title: { ar: 'خطة الشهر المقترحة', en: 'Proposed monthly plan' },
      goal: { ar: 'ملء الأوقات الهادئة وإعادة العميلات', en: 'Fill quiet times and bring customers back' },
      initiatives: inp.opportunities.filter((o) => !(o.promotional && (o.checks.capacity === 'blocked' || o.free_slots_in_period === 0))).map((o) => ({
        opportunity_ref: o.ref, title: { ar: 'مبادرة مقترحة', en: 'Proposed initiative' }, content_idea: { ar: 'صور حقيقية ورسالة قصيرة', en: 'Real photos and a short message' }, budget_minor: opts.budget ?? null, numbers: [],
      })),
      limitations: [],
      numbers: [],
      ...opts.plan,
    },
  };
}

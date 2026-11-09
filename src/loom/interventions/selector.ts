import { checkMargin } from '../checks';
import type { ActionKind } from '../contracts/opportunity';
import type { DetectContext, OpportunityCandidate } from '../detectors/types';
import type { InterventionDef, InterventionId } from '../sector/types';
import { L, type Localized } from '../util/text';

/**
 * Intervention selector (§6.7): the sector pack orders the interventions per
 * detector; the FIRST one that passes the constraints is chosen. Preferences
 * are hard constraints: no_discounts (or a 0 cap) removes every discount
 * intervention outright; a discount is always the last option and is only
 * chosen when the break-even check passes (m₁ > 0) and costs are complete.
 * Price reviews only ever propose a measured INCREASE review — never a cut.
 */
export type ChosenIntervention = InterventionDef & { discount_bp: number | null; direction: 'increase_review' | null; rationale: Localized | null };
export type Selection = { chosen: ChosenIntervention | null; alternatives: Array<{ kind: ActionKind; intervention_id: InterventionId; rejected_because: Localized }> };

function marginOk(dc: DetectContext, offeringId: string | null) {
  if (!offeringId) return false;
  const m = checkMargin(dc.ctx, offeringId);
  return m.status === 'ok';
}

/** Another active service with a known, positive margin (a package complement). */
function complement(dc: DetectContext, exclude: string[]) {
  return dc.ctx.activeServices.filter((o) => !exclude.includes(o.id) && !dc.profile.prefs.excluded_offerings.includes(o.id) && marginOk(dc, o.id))
    .sort((a, b) => (dc.metrics.value('sales.completed_count', `offering:${b.id}`) ?? 0) - (dc.metrics.value('sales.completed_count', `offering:${a.id}`) ?? 0) || a.id.localeCompare(b.id))[0] ?? null;
}

function evaluate(id: InterventionId, c: OpportunityCandidate, dc: DetectContext): { ok: true; discount_bp?: number; direction?: 'increase_review'; rationale?: Localized } | { ok: false; why: Localized } {
  const off = c.check_offering_id;
  const consented = dc.ctx.consentedCustomers;
  const no = (ar: string, en: string) => ({ ok: false as const, why: L(ar, en) });
  switch (id) {
    case 'targeted_reminder': case 'reminder_due':
      return consented > 0 ? { ok: true } : no('لا توجد عميلات بموافقة تسويقية', 'No customers with marketing consent');
    case 'off_peak_package': {
      if (!off || !marginOk(dc, off)) return no('الخدمة الأساسية بلا هامش معروف وموجب', 'The main service has no known positive margin');
      return complement(dc, [off]) ? { ok: true } : no('لا يوجد مكمّل بهامش موجب', 'No complementary service with a positive margin');
    }
    case 'value_add': case 'gift_with_service':
      return off && marginOk(dc, off) ? { ok: true } : no('الهامش غير معروف أو ضعيف؛ لا تُضاف قيمة على حسابه', 'The margin is unknown or thin; no added value at its expense');
    case 'bundle_with_top_service': {
      const top = (c.meta.top_service_id as string | undefined) ?? off;
      return top && marginOk(dc, top) ? { ok: true } : no('الخدمة الرائجة بلا هامش معروف وموجب', 'The popular service has no known positive margin');
    }
    case 'bundle_with_service': {
      const svc = c.meta.service_id as string | undefined;
      return svc && marginOk(dc, svc) ? { ok: true } : no('هامش الخدمة غير معروف', 'The service margin is unknown');
    }
    case 'loyalty_reward': case 'loyalty_program':
      return dc.ds.customers.length >= 20 ? { ok: true } : no('عدد العميلات أقل من أن يبرر برنامج ولاء', 'Too few customers to justify a loyalty program');
    case 'add_images':
      return c.meta.has_image === true ? no('للخدمة صورة بالفعل', 'The service already has a photo') : { ok: true };
    case 'improve_description':
      return c.meta.has_description === true && c.category === 'offering_presentation' ? no('للخدمة وصف بالفعل', 'The service already has a description') : { ok: true };
    case 'price_review':
      // Only an increase review, backed by the business's own margin or demand evidence (never a competitor price alone, T15).
      if (c.category !== 'margin_leak' && c.category !== 'unserved_demand') return no('لا يوجد دليل داخلي على الهامش أو الطلب', 'No internal margin or demand evidence');
      return { ok: true, direction: 'increase_review', rationale: L('مبني على هامش المنشأة أو طلبها، لا على أسعار المنافسين.', 'Based on the business’s own margin or demand, not on competitor prices.') };
    case 'limited_discount': {
      const max = dc.profile.prefs.max_discount_bp;
      if (dc.profile.prefs.no_discounts || max <= 0) return no('الخصومات غير مسموحة في إعداداتك', 'Discounts are not allowed in your settings');
      if (!off) return no('لا توجد خدمة محددة للخصم', 'No specific service to discount');
      const d = Math.min(max, dc.pack.default_discount_bp);
      const m = checkMargin(dc.ctx, off, { discount_bp: d, baseline_volume: c.baseline_volume || 1 });
      if (m.status === 'costs_incomplete') return no('التكاليف ناقصة؛ لا يُحسب التعادل', 'Costs are incomplete; break-even cannot be computed');
      if (m.discount_rejected) return no('الهامش بعد الخصم صفر أو أقل', 'The margin after the discount is zero or less');
      return { ok: true, discount_bp: d, rationale: L('تجربة محدودة فقط لعدم وجود أدلة استجابة سابقة.', 'A limited trial only: there is no prior response evidence.') };
    }
    default:
      return { ok: true };
  }
}

export function selectIntervention(c: OpportunityCandidate, dc: DetectContext, category = c.category): Selection {
  const order = dc.pack.interventions[category] ?? [];
  const alternatives: Selection['alternatives'] = [];
  let chosen: ChosenIntervention | null = null;
  for (const id of order) {
    const def = dc.pack.catalog[id];
    // Hard preference: no discount intervention exists at all under no_discounts.
    if (def.discount && (dc.profile.prefs.no_discounts || dc.profile.prefs.max_discount_bp <= 0)) continue;
    if (chosen) { alternatives.push({ kind: def.kind, intervention_id: id, rejected_because: L('خيار أدنى في الترتيب بعد اختيار تدخل مناسب', 'Lower in the order after a suitable intervention was chosen') }); continue; }
    const r = evaluate(id, c, dc);
    if (r.ok) chosen = { ...def, discount_bp: r.discount_bp ?? null, direction: r.direction ?? null, rationale: r.rationale ?? null };
    else alternatives.push({ kind: def.kind, intervention_id: id, rejected_because: r.why });
  }
  return { chosen, alternatives };
}

import type { CapacityStatus, InventoryStatus, MarginStatus } from '../contracts/opportunity';
import { breakEven } from '../economics/unit';
import type { MetricContext } from '../metrics/context';
import { L, pct, type Localized } from '../util/text';
import { convertQty } from '../util/units';

/**
 * Feasibility checks (§6.6, §7). Pure functions of the metric context.
 */

export type CapacityResult = { status: CapacityStatus; max_additional: number | null; available_slots: number | null; resources: string[]; note: Localized };

/**
 * Time & resources: bookable slots for QUALIFIED staff in their free windows
 * (after approved leave, blocks and bookings) over the next 14 days, minus
 * the volume already reserved by accepted initiatives on the same offering
 * (conflicts are deducted first). Required room/equipment types with no active
 * resource ⇒ blocked. No schedule at all ⇒ unknown.
 */
export function checkCapacity(ctx: MetricContext, offeringId: string | null, target: number | null, reserved = 0): CapacityResult {
  if (!offeringId) return { status: 'ok', max_additional: null, available_slots: null, resources: [], note: L('لا يتطلب طاقة إضافية.', 'Needs no extra capacity.') };
  const o = ctx.offeringById.get(offeringId);
  if (!o || o.kind !== 'service') return { status: 'ok', max_additional: null, available_slots: null, resources: [], note: L('ليست خدمة بمواعيد.', 'Not an appointment-based service.') };
  const types = ctx.ds.requirements.filter((r) => r.offering_id === offeringId && r.type === 'resource');
  for (const t of types) {
    const have = ctx.ds.resources.filter((r) => r.active && r.kind !== 'staff' && r.type_ref === t.ref_id).length;
    if (have < t.quantity) return { status: 'blocked', max_additional: 0, available_slots: 0, resources: [], note: L('تتطلب الخدمة غرفة أو جهازًا غير متاح.', 'The service needs a room or equipment that is not available.') };
  }
  const qualified = ctx.qualifiedResources(offeringId);
  if (!qualified.length) return { status: 'blocked', max_additional: 0, available_slots: 0, resources: [], note: L('لا توجد أخصائية مؤهلة لهذه الخدمة.', 'No specialist is qualified for this service.') };
  const ids = new Set(qualified);
  const scheduled = ctx.minutes(['free', 'booked', 'leave', 'blocked'], ctx.todayStart, ctx.horizonEnd, ids);
  if (scheduled === 0) return { status: 'unknown', max_additional: null, available_slots: null, resources: qualified, note: L('لا توجد جداول عمل للأخصائيات المؤهلات في الأسبوعين القادمين.', 'No working schedule for qualified specialists in the next two weeks.') };
  const need = (o.duration_min ?? 60) + o.buffer_min;
  let slots = 0;
  for (const w of ctx.ds.capacity) {
    if (w.state !== 'free' || !ids.has(w.resource_id)) continue;
    const s = Math.max(w.start, Math.max(ctx.todayStart, ctx.now)), e = Math.min(w.end, ctx.horizonEnd);
    if (e > s) slots += Math.floor((e - s) / 60_000 / need);
  }
  const available = Math.max(0, slots - reserved);
  const t = target ?? 1;
  const status: CapacityStatus = available >= t ? 'ok' : available > 0 ? 'constrained' : 'blocked';
  const note = status === 'ok' ? L(`${available} موعدًا متاحًا لأخصائيات مؤهلات خلال ١٤ يومًا.`, `${available} bookable slots for qualified specialists in 14 days.`)
    : status === 'constrained' ? L(`الطاقة تكفي حتى ${available} خدمة فقط من ${t} مستهدفة.`, `Capacity covers only ${available} of ${t} targeted services.`)
      : L('لا توجد مواعيد متاحة لأخصائيات مؤهلات خلال ١٤ يومًا.', 'No bookable time for qualified specialists in the next 14 days.');
  return { status, max_additional: available, available_slots: slots, resources: qualified, note: reserved ? L(`${note.ar} (بعد خصم ${reserved} محجوزة لمبادرات معتمدة)`, `${note.en} (after ${reserved} reserved by approved initiatives)`) : note };
}

export type InventoryResult = { status: InventoryStatus; covers_n: number | null; reorder: Array<{ item_id: string; name: string; needed: number; available: number; unit: string }>; note: Localized };

/**
 * Materials: only an APPROVED consumption recipe is used. No recipe ⇒
 * no_recipe and no count is ever estimated. covers_n = floor(min(available_i ÷ qty_i)).
 */
export function checkInventory(ctx: MetricContext, offeringId: string | null, target: number | null): InventoryResult {
  const na = (note: Localized): InventoryResult => ({ status: 'not_applicable', covers_n: null, reorder: [], note });
  if (!offeringId) return na(L('لا يستهلك مواد.', 'Uses no materials.'));
  const o = ctx.offeringById.get(offeringId);
  if (!o) return na(L('غير معروف.', 'Unknown.'));
  const itemBy = new Map(ctx.ds.inventory.map((i) => [i.id, i]));
  if (o.kind === 'product') {
    const it = ctx.ds.inventory.find((i) => i.offering_id === o.id && i.active);
    if (!it) return { status: 'no_recipe', covers_n: null, reorder: [], note: L('لا يوجد صنف مخزون مرتبط بالمنتج.', 'No stock item is linked to this product.') };
    const covers = Math.max(0, Math.floor(it.on_hand - it.reserved));
    const t = target ?? 1;
    return { status: covers >= t ? 'ok' : 'reorder_needed', covers_n: covers, reorder: covers >= t ? [] : [{ item_id: it.id, name: it.name, needed: t, available: covers, unit: it.unit }],
      note: L(`المتاح ${covers} وحدة.`, `${covers} units available.`) };
  }
  if (o.kind !== 'service') return na(L('لا ينطبق.', 'Not applicable.'));
  const recipe = ctx.ds.requirements.filter((r) => r.offering_id === offeringId && r.type === 'material');
  if (!recipe.length) return { status: 'no_recipe', covers_n: null, reorder: [], note: L('لا توجد وصفة استهلاك؛ لا يمكن تقدير عدد الخدمات التي يكفيها المخزون.', 'There is no consumption recipe; the number of services the stock can cover cannot be estimated.') };
  if (recipe.some((r) => r.confidence !== 'recipe')) return { status: 'no_recipe', covers_n: null, reorder: [], note: L('وصفة الاستهلاك غير معتمدة؛ لا يُقدَّر عدد الخدمات.', 'The consumption recipe is not approved; no count is estimated.') };
  let covers = Infinity;
  const lines: Array<{ item_id: string; name: string; per: number; available: number; unit: string; reorder_level: number | null }> = [];
  for (const r of recipe) {
    const it = itemBy.get(r.ref_id ?? '');
    const per = it ? convertQty(r.quantity, r.unit, it.unit) : null;
    if (!it || per === null || per <= 0) return { status: 'no_recipe', covers_n: null, reorder: [], note: L('وحدة الوصفة لا تطابق وحدة المخزون؛ لا يُقدَّر عدد الخدمات.', 'The recipe unit does not match the stock unit; no count is estimated.') };
    const available = Math.max(0, it.on_hand - it.reserved);
    covers = Math.min(covers, Math.floor(available / per + 1e-9));
    lines.push({ item_id: it.id, name: it.name, per, available, unit: it.unit, reorder_level: it.reorder_level });
  }
  const n = covers === Infinity ? 0 : covers;
  const t = target ?? 1;
  if (t > n) {
    return { status: 'reorder_needed', covers_n: n, reorder: lines.filter((l) => Math.floor(l.available / l.per + 1e-9) < t).map((l) => ({ item_id: l.item_id, name: l.name, needed: Math.ceil(t * l.per * 1000) / 1000, available: l.available, unit: l.unit })),
      note: L(`المخزون يكفي ${n} خدمة فقط من ${t} مستهدفة.`, `Stock covers only ${n} of ${t} targeted services.`) };
  }
  const low = lines.some((l) => l.reorder_level !== null && l.available - t * l.per < l.reorder_level);
  return { status: low ? 'constrained' : 'ok', covers_n: n, reorder: [], note: low ? L(`المخزون يكفي ${n} خدمة لكنه سيقل عن حد إعادة الطلب.`, `Stock covers ${n} services but will drop below the reorder level.`) : L(`المخزون يكفي ${n} خدمة.`, `Stock covers ${n} services.`) };
}

export type MarginResult = {
  status: MarginStatus; unit_margin_before_minor: number | null; unit_margin_after_minor: number | null; breakeven_volume_increase: number | null;
  completeness: number | null; discount_rejected: boolean; note: Localized;
};

/** §7: margin before/after the intervention; costs below the completeness threshold ⇒ costs_incomplete and no absolute numbers. */
export function checkMargin(ctx: MetricContext, offeringId: string | null, opts: { discount_bp?: number | null; campaign_cost_minor?: number; baseline_volume?: number | null; thin_below?: number } = {}): MarginResult {
  const none = (status: MarginStatus, note: Localized, completeness: number | null = null): MarginResult => ({ status, unit_margin_before_minor: null, unit_margin_after_minor: null, breakeven_volume_increase: null, completeness, discount_rejected: false, note });
  if (!offeringId) return none('not_applicable', L('لا ينطبق.', 'Not applicable.'));
  const e = ctx.economics(offeringId);
  if (!e) return none('not_applicable', L('لا ينطبق.', 'Not applicable.'));
  const thr = ctx.settings.cost_completeness_threshold;
  if (e.completeness < thr || e.variable_minor === null || e.margin_minor === null) {
    return none('costs_incomplete', L(`التكاليف مسجلة لـ ${pct(e.completeness)} من المبيعات (الحد ${pct(thr)})؛ لا تُعلن ربحية.`, `Costs are recorded for ${pct(e.completeness)} of sales (threshold ${pct(thr)}); no profitability is stated.`), e.completeness);
  }
  const ratio = e.margin_ratio ?? 0;
  let status: MarginStatus = e.margin_minor <= 0 ? 'negative' : ratio < (opts.thin_below ?? 0.2) ? 'thin' : 'ok';
  let after: number | null = null, inc: number | null = null, rejected = false;
  let note = L(`هامش الوحدة ${e.margin_minor} (${pct(ratio)}).`, `Unit margin ${e.margin_minor} (${pct(ratio)}).`);
  if (opts.discount_bp) {
    const be = breakEven({ price_minor: e.price_minor, variable_minor: e.variable_minor, discount_bp: opts.discount_bp, campaign_cost_minor: opts.campaign_cost_minor, baseline_volume: opts.baseline_volume ?? undefined });
    after = Math.round(be.m1);
    if (be.rejected) { rejected = true; status = 'negative'; note = L('الهامش بعد الخصم صفر أو أقل؛ رُفض الخصم.', 'The margin after the discount is zero or less; the discount is rejected.'); }
    else { inc = Math.round(be.volume_increase * 1000) / 1000; note = L(`يلزم زيادة الحجم ${pct(inc, 1)} لتعويض الخصم.`, `Volume must rise ${pct(inc, 1)} to offset the discount.`); }
  }
  return { status, unit_margin_before_minor: e.margin_minor, unit_margin_after_minor: after ?? e.margin_minor, breakeven_volume_increase: inc, completeness: e.completeness, discount_rejected: rejected, note };
}

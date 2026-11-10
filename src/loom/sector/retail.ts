import type { Offering } from '../contracts/canonical';
import { DETECTORS, ev } from '../detectors/v1';
import type { DetectContext, Detector, OpportunityCandidate } from '../detectors/types';
import type { MetricContext } from '../metrics/context';
import { defineMetric } from '../metrics/registry';
import { slowMovers } from '../metrics/v1';
import { L, pct, type Localized } from '../util/text';
import { addDays } from '../util/time';
import { beautyPack } from './beauty';
import type { InterventionDef, InterventionId, SectorPack } from './types';

/**
 * Retail sector pack (§16 "متجر"): capacity = sellable inventory + order
 * preparation + delivery capacity. Products are sold in baskets, so the
 * retail detectors look at stock cover, slow movers, basket co-purchase and
 * restocking before a documented promotion window. Interventions reuse the
 * engine's intervention ids with retail wording (the selector's constraints
 * still apply: margins must be known and positive, discounts last).
 */
const DAY = 86_400_000;

// ── Order fulfilment capacity (preparation + delivery) ──────────────────────
/**
 * Orders the business can prepare and deliver in the next 14 days, from the
 * free capacity windows of staff (preparation) and vehicles (delivery).
 * null when no window exists (capacity unknown, never assumed).
 */
export function orderCapacity(ctx: MetricContext, params: Record<string, number>) {
  return ctx.memo('retail.orderCapacity', () => {
    const ids = (kinds: string[]) => new Set(ctx.ds.resources.filter((r) => r.active && kinds.includes(r.kind)).map((r) => r.id));
    const prepIds = ids(['staff', 'generic']), delIds = ids(['vehicle']);
    const prepMin = ctx.minutes(['free'], Math.max(ctx.todayStart, ctx.now), ctx.horizonEnd, prepIds);
    const delMin = ctx.minutes(['free'], Math.max(ctx.todayStart, ctx.now), ctx.horizonEnd, delIds);
    const anyPrep = ctx.minutes(['free', 'booked', 'blocked', 'leave'], ctx.todayStart, ctx.horizonEnd, prepIds) > 0;
    const anyDel = ctx.minutes(['free', 'booked', 'blocked', 'leave'], ctx.todayStart, ctx.horizonEnd, delIds) > 0;
    const prep = anyPrep ? Math.floor(prepMin / (params.prep_min_per_order ?? 6)) : null;
    const delivery = anyDel ? Math.floor(delMin / (params.delivery_min_per_order ?? 20)) : null;
    const known = [prep, delivery].filter((x): x is number => x !== null);
    return { prep, delivery, orders: known.length ? Math.min(...known) : null };
  });
}

const pack = () => retailPack;
const isSellable = (ctx: MetricContext) => new Map(ctx.ds.inventory.filter((i) => i.active && i.usage !== 'consumable' && i.offering_id).map((i) => [i.offering_id!, i]));
const unitsSold = (c: DetectContext, offeringId: string) => c.ctx.sales90.reduce((m, t) => m + t.lines.filter((l) => l.offering_id === offeringId).reduce((a, l) => a + l.qty, 0), 0);
const activeProducts = (c: DetectContext) => c.ctx.activeOfferings.filter((o) => o.kind === 'product');
const marginOk = (c: DetectContext, id: string) => { const e = c.ctx.economics(id); return !!e && e.completeness >= c.ctx.settings.cost_completeness_threshold && (e.margin_minor ?? 0) > 0; };

defineMetric({
  key: 'retail.order_capacity_next14', version: 1, label: L('طاقة تجهيز وتوصيل الطلبات (١٤ يومًا)', 'Order preparation & delivery capacity (14 days)'), unit: 'count', grain: ['business'],
  window: 'P14D-forward', formula: 'min(free preparation minutes ÷ prep_min_per_order, free delivery minutes ÷ delivery_min_per_order) over staff/vehicle windows',
  requires: ['CapacityWindow', 'Resource'], min_sample: 0, sectors: ['retail'], domain: 'capacity',
  compute: (c) => { const o = orderCapacity(c, pack().params ?? {}); return [{ grain_ref: 'business', value: o.orders, n: o.orders === null ? 0 : 1, missing_input: o.orders === null }]; },
});
defineMetric({
  key: 'retail.basket_size', version: 1, label: L('متوسط عدد القطع في السلة', 'Average units per basket'), unit: 'units', grain: ['business'],
  window: 'P90D', formula: 'Σ line qty ÷ fulfilled orders', requires: ['Transaction'], min_sample: 10, sectors: ['retail'], domain: 'sales',
  compute: (c) => { const s = c.sales90.filter((t) => t.kind === 'order'); const u = s.reduce((m, t) => m + t.lines.reduce((a, l) => a + l.qty, 0), 0); return [{ grain_ref: 'business', value: s.length ? u / s.length : null, n: s.length }]; },
});
defineMetric({
  key: 'retail.units_sold_90d', version: 1, label: L('القطع المباعة (٩٠ يومًا)', 'Units sold (90 days)'), unit: 'units', grain: ['offering'],
  window: 'P90D', formula: 'Σ qty of fulfilled lines per product', requires: ['Transaction'], min_sample: 0, sectors: ['retail'], domain: 'sales',
  compute: (c) => c.activeOfferings.filter((o) => o.kind === 'product').map((o) => {
    const lines = c.salesLinesByOffering.get(o.id) ?? [];
    return { grain_ref: `offering:${o.id}`, value: lines.reduce((m, s) => m + s.line.qty, 0), n: lines.length };
  }),
});

function base(c: DetectContext, p: Partial<OpportunityCandidate> & Pick<OpportunityCandidate, 'detector_id' | 'category' | 'subject_key' | 'title' | 'why_now' | 'evidence'>): OpportunityCandidate {
  return {
    subject: { offering_ids: [] }, hypotheses: [], target_volume: null, baseline_volume: null, check_offering_id: null,
    window: { from: c.ctx.today, to: addDays(c.ctx.today, 13) }, goal_kinds: [], channels: [], segment: { definition: {}, size: null, size_status: 'unknown' },
    success_metrics: [], measurement_design: 'observational', limitations: [], assumptions: [], prerequisites: [], sample: { n: 0, min: 1 }, promotional: false, meta: {},
    ...p,
  };
}

/** Promotional retail candidates name the fulfilment limit when expected orders exceed it. */
function fulfilment(c: DetectContext, target: number): { prereq: Localized[]; limitation: Localized[] } {
  const cap = orderCapacity(c.ctx, c.pack.params ?? {});
  if (cap.orders === null) return { prereq: [], limitation: [L('طاقة تجهيز الطلبات والتوصيل غير مسجلة؛ لم تُفحص.', 'Order preparation and delivery capacity is not recorded and was not checked.')] };
  if (cap.orders >= target) return { prereq: [], limitation: [] };
  return { prereq: [L(`طاقة التجهيز والتوصيل تكفي ${cap.orders} طلبًا فقط من ${target}؛ أضيفي وردية تجهيز أو توصيل قبل الترويج.`, `Preparation and delivery capacity covers only ${cap.orders} of ${target} orders; add a packing or delivery shift before promoting.`)], limitation: [] };
}

export const retailSlowMoverBundle: Detector = {
  id: 'retail_slow_mover_bundle', sectors: ['retail'], requires: ['inventory.slow_movers', 'retail.units_sold_90d'], minQuality: { sales: 'limited' },
  detect(c) {
    const top = activeProducts(c).filter((o) => marginOk(c, o.id)).sort((a, b) => unitsSold(c, b.id) - unitsSold(c, a.id) || a.id.localeCompare(b.id))[0];
    if (!top || unitsSold(c, top.id) === 0) return [];
    const coverDays = c.params.cover_days ?? 180;
    const slow = slowMovers(c.ctx).filter((i) => i.offering_id !== top.id && (i.sold_90d === 0 || (i.on_hand - i.reserved) / (i.sold_90d / 90) > coverDays)).slice(0, 2);
    return slow.map((item) => {
      const prod = c.ctx.offeringById.get(item.offering_id!);
      const target = Math.min(item.on_hand - item.reserved, Math.max(1, Math.ceil(((unitsSold(c, top.id) * 14) / 90) * 0.2)));
      const f = fulfilment(c, target);
      return base(c, {
        detector_id: 'retail_slow_mover_bundle', category: 'slow_mover_bundle', subject_key: `item:${item.id}`, subject: { offering_ids: [top.id, ...(prod ? [prod.id] : [])], item_ids: [item.id] },
        title: L(`تحريك ${item.name} مع ${top.name.ar}`, `Move ${item.name} with ${top.name.en}`),
        why_now: L(`${item.on_hand - item.reserved} قطعة من ${item.name} في المخزون وبيع منها ${item.sold_90d} خلال ٩٠ يومًا، بينما ${top.name.ar} الأكثر مبيعًا (${unitsSold(c, top.id)} قطعة).`,
          `${item.on_hand - item.reserved} units of ${item.name} in stock with ${item.sold_90d} sold in 90 days, while ${top.name.en} is the best seller (${unitsSold(c, top.id)} units).`),
        evidence: [ev(c, 'inventory.on_hand', `item:${item.id}`), ev(c, 'inventory.days_of_cover', `item:${item.id}`), ev(c, 'retail.units_sold_90d', `offering:${top.id}`)],
        hypotheses: [L('قد لا يكون المنتج معروضًا قرب المنتجات التي يشتريها العملاء.', 'The product may not be shown next to what customers already buy.')],
        target_volume: target, check_offering_id: prod?.id ?? null, goal_kinds: ['sell_products'], channels: ['storefront', 'in_store'],
        measurement_design: 'pre_post_with_control', prerequisites: f.prereq, limitations: [L('المقارنة قبل/بعد ليست سببية.', 'Before/after is not causal.'), ...f.limitation],
        success_metrics: [{ metric_key: `retail.units_sold_90d@offering:${prod?.id ?? item.id}`, baseline: item.sold_90d, target: item.sold_90d + target }],
        sample: { n: unitsSold(c, top.id), min: 5 }, promotional: true, meta: { item_id: item.id, top_service_id: top.id, product_offering_id: prod?.id ?? null },
      });
    });
  },
};

export const stockoutRisk: Detector = {
  id: 'stockout_risk', sectors: ['retail', 'restaurant'], requires: ['inventory.days_of_cover', 'inventory.weekly_usage'], minQuality: { sales: 'limited' },
  detect(c) {
    const below = c.params.cover_days_below ?? 14;
    const sellable = isSellable(c.ctx);
    const out: OpportunityCandidate[] = [];
    for (const o of activeProducts(c)) {
      const it = sellable.get(o.id);
      if (!it) continue;
      const avail = it.on_hand - it.reserved;
      const sold = unitsSold(c, o.id) || it.sold_90d;
      if (sold <= 0) continue;
      const daily = sold / 90;
      const cover = avail / daily;
      const atReorder = it.reorder_level !== null && avail <= it.reorder_level;
      if (cover >= below && !atReorder) continue;
      const lost = Math.max(0, Math.ceil(daily * below - avail));
      out.push(base(c, {
        detector_id: 'stockout_risk', category: 'stockout_risk', subject_key: `item:${it.id}`, subject: { offering_ids: [o.id], item_ids: [it.id] },
        title: L(`خطر نفاد ${o.name.ar}`, `${o.name.en} may sell out`),
        why_now: L(`المتاح ${avail} قطعة ويُباع نحو ${daily.toFixed(1)} يوميًا: يكفي ${Math.floor(cover)} يومًا فقط${atReorder ? ' وبلغ حد إعادة الطلب' : ''}.`,
          `${avail} units available selling about ${daily.toFixed(1)} a day: about ${Math.floor(cover)} days of cover${atReorder ? ', at the reorder level' : ''}.`),
        evidence: [ev(c, 'inventory.on_hand', `item:${it.id}`), ev(c, 'inventory.days_of_cover', `item:${it.id}`), ev(c, 'retail.units_sold_90d', `offering:${o.id}`)],
        hypotheses: [L('قد تُفقد مبيعات إذا نفد المنتج قبل وصول الطلبية.', 'Sales may be lost if it sells out before a reorder arrives.')],
        target_volume: lost || null, check_offering_id: null, goal_kinds: ['sell_products', 'increase_margin'], channels: ['in_store'],
        success_metrics: [{ metric_key: `inventory.days_of_cover@item:${it.id}`, baseline: Math.round(cover * 10) / 10, target: below }],
        measurement_design: 'observational', sample: { n: sold, min: 5 }, promotional: false,
        limitations: [L('التقدير من متوسط مبيعات ٩٠ يومًا ولا يشمل الموسمية.', 'Estimated from the 90-day average; seasonality is not included.')],
        meta: { item_id: it.id, cover_days: cover, lost_units: lost },
      }));
    }
    return out.sort((a, b) => (a.meta.cover_days as number) - (b.meta.cover_days as number)).slice(0, 3);
  },
};

export const reorderBeforePromotion: Detector = {
  id: 'reorder_before_promotion', sectors: ['retail'], requires: ['inventory.days_of_cover'], minQuality: { sales: 'limited' },
  detect(c) {
    const horizon = addDays(c.ctx.today, c.params.horizon_days ?? 30);
    const event = c.ds.calendar.filter((e) => e.verified && e.starts_on >= c.ctx.today && e.starts_on <= horizon).sort((a, b) => a.starts_on.localeCompare(b.starts_on))[0];
    if (!event) return [];
    const daysTo = Math.max(1, Math.round((Date.parse(`${event.starts_on}T00:00:00Z`) - Date.parse(`${c.ctx.today}T00:00:00Z`)) / DAY));
    const uplift = c.params.event_uplift ?? 1.5;
    const sellable = isSellable(c.ctx);
    const top = activeProducts(c).filter((o) => sellable.has(o.id) && unitsSold(c, o.id) > 0).sort((a, b) => unitsSold(c, b.id) - unitsSold(c, a.id) || a.id.localeCompare(b.id)).slice(0, 5);
    const short = top.map((o) => {
      const it = sellable.get(o.id)!;
      const need = Math.ceil((unitsSold(c, o.id) / 90) * (daysTo + 7 * uplift));
      return { o, it, need, avail: it.on_hand - it.reserved };
    }).filter((x) => x.avail < x.need);
    if (!short.length) return [];
    const names = short.map((x) => x.o.name);
    return [base(c, {
      detector_id: 'reorder_before_promotion', category: 'capacity_prerequisite', subject_key: `event:${event.id}`, subject: { offering_ids: short.map((x) => x.o.id), item_ids: short.map((x) => x.it.id) },
      title: L(`إعادة الطلب قبل «${event.title}»`, `Reorder before “${event.title}”`),
      why_now: L(`«${event.title}» بعد ${daysTo} يومًا، ومخزون ${names.map((n) => n.ar).join('، ')} لا يكفي الطلب المتوقع حتى نهاية أسبوع الموسم.`,
        `“${event.title}” is in ${daysTo} days and stock of ${names.map((n) => n.en).join(', ')} will not cover expected demand through the season week.`),
      evidence: short.flatMap((x) => [ev(c, 'inventory.on_hand', `item:${x.it.id}`), ev(c, 'retail.units_sold_90d', `offering:${x.o.id}`)]),
      window: { from: c.ctx.today, to: event.starts_on }, goal_kinds: ['sell_products'], channels: ['in_store'],
      prerequisites: short.map((x) => L(`إعادة طلب ${x.it.name}: المتوقع ${x.need} والمتاح ${x.avail}`, `Reorder ${x.it.name}: ${x.need} expected, ${x.avail} available`)),
      success_metrics: short.map((x) => ({ metric_key: `inventory.on_hand@item:${x.it.id}`, baseline: x.avail, target: x.need })),
      measurement_design: 'observational', sample: { n: short.reduce((m, x) => m + unitsSold(c, x.o.id), 0), min: 5 }, promotional: false,
      assumptions: [L(`الطلب في أسبوع الموسم ×${uplift} من المتوسط (معامل الحزمة).`, `Season-week demand ×${uplift} of the average (pack parameter).`)],
      limitations: [L('المناسبة من التقويم المعتمد فقط؛ لا تُنشئ فرصة ترويجية بمفردها.', 'The event comes from the verified calendar only; it never creates a promotion by itself.')],
      meta: { event_id: event.id, no_prerequisite_conversion: true },
    })];
  },
};

export const basketCrossSell: Detector = {
  id: 'basket_cross_sell', sectors: ['retail'], requires: ['retail.basket_size'], minQuality: { sales: 'limited' }, needsSegmentation: true,
  detect(c) {
    const baskets = c.ctx.sales90.filter((t) => t.lines.length > 0).map((t) => new Set(t.lines.map((l) => l.offering_id)));
    if (baskets.length < (c.params.min_baskets ?? 20)) return [];
    const prods = new Set(activeProducts(c).map((o) => o.id));
    const count = new Map<string, number>();
    const pair = new Map<string, number>();
    for (const b of baskets) {
      const ids = [...b].filter((x) => prods.has(x)).sort();
      for (const a of ids) count.set(a, (count.get(a) ?? 0) + 1);
      for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) pair.set(`${ids[i]}|${ids[j]}`, (pair.get(`${ids[i]}|${ids[j]}`) ?? 0) + 1);
    }
    let best: { anchor: Offering; add: Offering; lift: number; co: number; conf: number } | null = null;
    for (const [k, co] of pair) {
      if (co < (c.params.min_co_baskets ?? 5)) continue;
      const [a, b] = k.split('|') as [string, string];
      for (const [anchor, add] of [[a, b], [b, a]] as const) {
        const conf = co / count.get(anchor)!;
        const lift = conf / (count.get(add)! / baskets.length);
        if (lift < (c.params.min_lift ?? 1.5) || !marginOk(c, anchor)) continue;
        // The add-on should be the one bought less often (room to grow).
        if (count.get(add)! > count.get(anchor)!) continue;
        if (!best || lift > best.lift || (lift === best.lift && `${anchor}|${add}` < `${best.anchor.id}|${best.add.id}`)) best = { anchor: c.ctx.offeringById.get(anchor)!, add: c.ctx.offeringById.get(add)!, lift, co, conf };
      }
    }
    if (!best) return [];
    const { anchor, add, lift, co, conf } = best;
    const target = Math.max(1, Math.ceil(((count.get(anchor.id)! - co) * 14) / 90 * 0.1));
    const f = fulfilment(c, target);
    return [base(c, {
      detector_id: 'basket_cross_sell', category: 'cross_sell_affinity', subject_key: `basket:${anchor.id}:${add.id}`, subject: { offering_ids: [anchor.id, add.id] },
      title: L(`${add.name.ar} مع ${anchor.name.ar}`, `${add.name.en} with ${anchor.name.en}`),
      why_now: L(`${pct(conf)} من سلال ${anchor.name.ar} تضم ${add.name.ar} (×${lift.toFixed(1)} من المعتاد) في ${co} سلة.`,
        `${pct(conf)} of baskets with ${anchor.name.en} include ${add.name.en} (×${lift.toFixed(1)} the usual rate) across ${co} baskets.`),
      evidence: [ev(c, 'retail.units_sold_90d', `offering:${anchor.id}`), ev(c, 'retail.units_sold_90d', `offering:${add.id}`), ev(c, 'retail.basket_size')],
      hypotheses: [L('قد يكون المنتجان مكملين؛ عرضهما معًا قد يرفع متوسط السلة.', 'The two products may complement each other; showing them together may raise the basket.')],
      target_volume: target, check_offering_id: add.id, goal_kinds: ['sell_products'], channels: ['storefront', 'in_store'],
      segment: { definition: { conditions: [{ type: 'visited_offering', offering_id: anchor.id }] }, size: count.get(anchor.id) ?? null, size_status: 'counted' },
      success_metrics: [{ metric_key: 'retail.basket_size', baseline: c.metrics.value('retail.basket_size'), target: null }],
      measurement_design: 'pre_post_with_control', sample: { n: co, min: c.params.min_co_baskets ?? 5 }, promotional: true, prerequisites: f.prereq,
      limitations: [L('الشراء المشترك لا يعني أن العرض المشترك سيزيد المبيعات.', 'Co-purchase does not mean a joint offer will increase sales.'), ...f.limitation],
      meta: { lift, service_id: anchor.id, product_id: add.id },
    })];
  },
};

export const RETAIL_DETECTORS: Detector[] = [retailSlowMoverBundle, stockoutRisk, reorderBeforePromotion, basketCrossSell];
for (const d of RETAIL_DETECTORS) if (!DETECTORS.some((x) => x.id === d.id)) DETECTORS.push(d);

const reword = (id: InterventionId, ar: string, en: string, patch: Partial<InterventionDef> = {}): InterventionDef => ({ ...beautyPack.catalog[id], ...patch, description: L(ar, en) });

const catalog: Record<InterventionId, InterventionDef> = {
  ...beautyPack.catalog,
  bundle_with_top_service: reword('bundle_with_top_service', 'حزمة تجمع المنتج بطيء الحركة مع المنتج الأكثر مبيعًا بهامش موجب.', 'A bundle of the slow mover with the best-selling product at a positive margin.'),
  gift_with_service: reword('gift_with_service', 'هدية بتكلفتها مع المنتج الأكثر مبيعًا لتصريف المخزون الراكد.', 'A gift at cost with the best seller to clear idle stock.'),
  bundle_with_service: reword('bundle_with_service', 'عرض المنتجين معًا في المتجر وصفحة المنتج («يُشترى معه عادة»).', 'Show both products together in store and on the product page (“often bought together”).'),
  in_store_recommendation: reword('in_store_recommendation', 'اقتراح المنتج المكمّل عند الدفع.', 'Suggest the complementary product at checkout.'),
  restock: reword('restock', 'إعادة الطلب من المورّد الآن بكمية تغطي المبيعات المتوقعة.', 'Reorder from the supplier now for the expected sales.'),
  add_shift: reword('add_shift', 'إضافة وردية تجهيز أو توصيل قبل الترويج.', 'Add a packing or delivery shift before promoting.'),
  content_feature: reword('content_feature', 'إبراز المنتج في أعلى المتجر الإلكتروني وواجهة المحل.', 'Feature the product at the top of the online store and in the shop window.'),
  improve_description: reword('improve_description', 'وصف أوضح للمنتج: المقاس والمكونات والاستخدام والسعر.', 'A clearer product description: size, ingredients, use and price.'),
  add_images: reword('add_images', 'إضافة صور حقيقية للمنتج.', 'Add real photos of the product.'),
  simplify_booking: reword('simplify_booking', 'تبسيط خطوات الطلب والدفع والتوصيل.', 'Simplify the order, payment and delivery steps.'),
  record_costs: reword('record_costs', 'تسجيل تكلفة الشراء لكل منتج.', 'Record each product’s purchase cost.'),
};

/** Retail (stores): capacity = sellable inventory + order preparation + delivery. */
export const retailPack: SectorPack = {
  id: 'retail',
  label: L('متجر', 'Retail'),
  version: 'retail-1.0.0',
  vocabulary: {
    resource: L('موظف', 'Staff member'), offering: L('منتج', 'Product'), customer: L('عميل', 'Customer'),
    transaction: L('طلب', 'Order'), capacity: L('طاقة التجهيز والتوصيل', 'Fulfilment capacity'), location: L('فرع', 'Store'),
  },
  capacityModel: { resources: ['staff', 'vehicle', 'generic'], unit: 'orders', quiet_below: 0.4, full_above: 0.9 },
  detectors: [
    { id: 'retail_slow_mover_bundle', params: { cover_days: 180 } },
    { id: 'stockout_risk', params: { cover_days_below: 14 } },
    { id: 'reorder_before_promotion', params: { horizon_days: 30, event_uplift: 1.5 } },
    { id: 'basket_cross_sell', params: { min_baskets: 20, min_co_baskets: 5, min_lift: 1.5 } },
    { id: 'margin_leak', params: { thin_below: 0.15 } },
    { id: 'missing_cost_blocker', params: {} },
    { id: 'offering_presentation', params: { min_views: 20 } },
    { id: 'conversion_friction', params: { min_starts: 30, max_start_to_confirm: 0.3 } },
    { id: 'loyalty_over_discount', params: { min_discount_share: 0.3, max_repeat: 0.25, min_customers: 30 } },
    { id: 'campaign_learning', params: { min_group: 30 } },
  ],
  interventions: {
    slow_mover_bundle: ['bundle_with_top_service', 'gift_with_service', 'limited_discount'],
    stockout_risk: ['restock'],
    capacity_prerequisite: ['restock', 'add_shift'],
    cross_sell_affinity: ['bundle_with_service', 'in_store_recommendation'],
    margin_leak: ['cost_review', 'price_review'],
    missing_cost_blocker: ['record_costs'],
    offering_presentation: ['add_images', 'improve_description'],
    conversion_friction: ['simplify_booking', 'improve_description'],
    loyalty_over_discount: ['loyalty_program'],
    campaign_learning: ['review_results'],
  },
  catalog,
  validation: { forbiddenClaims: [/الأرخص في السوق|أرخص سعر|cheapest|lowest price guaranteed|guaranteed/i], awarenessOnlyTopics: [] },
  default_discount_bp: 1000,
  metrics: { overrides: { 'retail.basket_size': { min_sample: 20 }, 'econ.unit_margin_ratio': { min_sample: 5 } } },
  quality: { core: ['sales', 'inventory'] },
  params: { prep_min_per_order: 6, delivery_min_per_order: 20 },
};

/**
 * Restaurant pack skeleton (§16 "مطعم"): capacity = kitchen preparation +
 * tables (covers) + ingredients + peak. Vocabulary and the generic detectors
 * only; restaurant-specific detectors (ingredient expiry, peak covers) are not
 * implemented yet, so the platform should not enable it for production use.
 */
export const restaurantPack: SectorPack = {
  id: 'restaurant',
  label: L('مطعم', 'Restaurant'),
  version: 'restaurant-0.1.0-skeleton',
  vocabulary: {
    resource: L('طاهٍ', 'Cook'), offering: L('طبق', 'Dish'), customer: L('ضيف', 'Guest'), transaction: L('طلب', 'Order'),
    capacity: L('التحضير والطاولات', 'Kitchen & tables'), location: L('فرع', 'Branch'),
  },
  capacityModel: { resources: ['staff', 'table', 'equipment'], unit: 'covers', quiet_below: 0.35, full_above: 0.9 },
  detectors: [
    { id: 'quiet_capacity', params: { min_available_min: 240, quiet_below: 0.35, max_slots: 3, uplift_pp: 0.05 } },
    { id: 'margin_leak', params: { thin_below: 0.25 } },
    { id: 'missing_cost_blocker', params: {} },
    { id: 'stockout_risk', params: { cover_days_below: 3 } },
    { id: 'campaign_learning', params: { min_group: 30 } },
  ],
  interventions: {
    quiet_capacity: ['targeted_reminder', 'off_peak_package', 'value_add', 'limited_discount'],
    margin_leak: ['cost_review', 'price_review'], missing_cost_blocker: ['record_costs'], stockout_risk: ['restock'],
    capacity_prerequisite: ['add_shift', 'restock'], campaign_learning: ['review_results'],
  },
  catalog: beautyPack.catalog,
  validation: { forbiddenClaims: [/صحي 100|يعالج|cures?|guaranteed/i], awarenessOnlyTopics: ['world_health_day'] },
  default_discount_bp: 1000,
  quality: { core: ['sales', 'capacity'] },
};

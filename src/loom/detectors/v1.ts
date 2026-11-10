import type { Offering } from '../contracts/canonical';
import { metricDefinition } from '../metrics/registry';
import { slowMovers } from '../metrics/v1';
import { L, median, pct, type Localized } from '../util/text';
import { addDays } from '../util/time';
import type { DetectContext, Detector, EvidenceItem, OpportunityCandidate } from './types';
import { demandForecastFor } from '../models/attach';

/**
 * v1 detectors (§6.4). Each is deterministic and reads only the dataset,
 * metrics, quality report and profile. Thresholds come from the sector pack.
 */
const DAYPART: Record<string, Localized> = { morning: L('الصباح', 'morning'), afternoon: L('الظهيرة', 'afternoon'), evening: L('المساء', 'evening') };
const WEEKDAY: Localized[] = [L('الأحد', 'Sunday'), L('الاثنين', 'Monday'), L('الثلاثاء', 'Tuesday'), L('الأربعاء', 'Wednesday'), L('الخميس', 'Thursday'), L('الجمعة', 'Friday'), L('السبت', 'Saturday')];
const slotName = (key: string): Localized => { const [wd, dp] = key.split('.'); return L(`${WEEKDAY[Number(wd)]!.ar} ${DAYPART[dp!]!.ar}`, `${WEEKDAY[Number(wd)]!.en} ${DAYPART[dp!]!.en}`); };
const nm = (o: Offering | undefined) => o?.name ?? L('—', '—');

export function ev(c: DetectContext, key: string, grain = 'business', grade: EvidenceItem['grade'] = 'observed'): EvidenceItem {
  const m = c.metrics.get(key, grain);
  const d = metricDefinition(key);
  return { metric_key: key, grain_ref: grain, value: m?.value ?? null, n: m?.n ?? 0, label: d?.label ?? L(key, key), grade };
}

function base(c: DetectContext, p: Partial<OpportunityCandidate> & Pick<OpportunityCandidate, 'detector_id' | 'category' | 'subject_key' | 'title' | 'why_now' | 'evidence'>): OpportunityCandidate {
  return {
    subject: { offering_ids: [] }, hypotheses: [], target_volume: null, baseline_volume: null, check_offering_id: null,
    window: { from: c.ctx.today, to: addDays(c.ctx.today, 13) }, goal_kinds: [], channels: [], segment: { definition: {}, size: null, size_status: 'unknown' },
    success_metrics: [], measurement_design: 'observational', limitations: [], assumptions: [], prerequisites: [], sample: { n: 0, min: 1 }, promotional: false, meta: {},
    ...p,
  };
}

const consentedSegment = (c: DetectContext, extra: Array<Record<string, unknown>> = []) => {
  const size = c.ctx.consentedCustomers;
  return { definition: { conditions: [...extra, { type: 'has_consent' }] }, size, size_status: size > 0 ? 'counted' as const : 'insufficient' as const };
};

/** Customers (pseudonymous) with a fulfilled visit for an offering, over the whole dataset. */
function customersOf(c: DetectContext, offeringId: string) {
  return c.ctx.memo(`cust:${offeringId}`, () => new Set(c.ds.transactions.filter((t) => t.status === 'fulfilled' && t.lines.some((l) => l.offering_id === offeringId)).map((t) => t.customer_ref)));
}

const completed = (c: DetectContext, id: string) => c.metrics.value('sales.completed_count', `offering:${id}`) ?? 0;

export const quietCapacity: Detector = {
  id: 'quiet_capacity', sectors: ['*'], requires: ['capacity.occupancy', 'capacity.free_minutes_next14'], minQuality: { capacity: 'limited' },
  detect(c) {
    const p = c.params;
    const next = new Map(c.ctx.nextSlots.map((s) => [s.key, s]));
    const quiet = c.ctx.pastSlots.filter((s) => s.available_min >= p.min_available_min! && (s.occupancy ?? 0) < p.quiet_below!)
      .filter((s) => { const n = next.get(s.key); return n && n.available_min - n.booked_min > 0 && (n.occupancy ?? 0) <= c.pack.capacityModel.full_above; })
      .sort((a, b) => (a.occupancy ?? 0) - (b.occupancy ?? 0)).slice(0, p.max_slots);
    if (!quiet.length) return [];
    const keys = quiet.map((s) => s.key).sort();
    const freeNext = quiet.reduce((m, s) => m + (next.get(s.key)!.available_min - next.get(s.key)!.booked_min), 0);
    const availNext = quiet.reduce((m, s) => m + next.get(s.key)!.available_min, 0);
    const offer = [...c.ctx.activeServices].filter((o) => c.ctx.qualifiedResources(o.id).length && !c.profile.prefs.excluded_offerings.includes(o.id))
      .sort((a, b) => completed(c, b.id) - completed(c, a.id) || a.id.localeCompare(b.id))[0];
    const dur = (offer?.duration_min ?? 60) + (offer?.buffer_min ?? 0);
    const names = quiet.map((s) => slotName(s.key));
    // Phase 6 (optional): the expected demand of the offering over the next two weeks, labelled with its source.
    const fc = offer && c.forecasts?.length ? demandForecastFor(c.forecasts, offer.id, c.ctx.today, addDays(c.ctx.today, 13)) : null;
    const fcNote = fc ? [L(`التوقع (${fc.row.source === 'model' ? `نموذج الإصدار ${fc.row.version}` : 'خط أساس'}) لطلب ${offer!.name.ar} خلال أسبوعين: ${fc.value} (بين ${fc.low} و${fc.high})؛ توقع وليس هدفًا.`,
      `Expected demand for ${offer!.name.en} over two weeks (${fc.row.source === 'model' ? `model version ${fc.row.version}` : 'baseline'}): ${fc.value} (${fc.low}–${fc.high}); a forecast, not a goal.`)] : [];
    return [base(c, {
      detector_id: 'quiet_capacity', category: 'quiet_capacity', subject_key: `slots:${keys.join(',')}`, subject: { offering_ids: offer ? [offer.id] : [], slots: keys },
      title: L('ملء الفترات الهادئة', 'Fill quiet periods'),
      why_now: L(`إشغال منخفض في ${names.map((x) => x.ar).join('، ')} خلال ٢٨ يومًا، ويوجد ${freeNext} دقيقة متاحة فيها خلال الأسبوعين القادمين.`,
        `Low occupancy in ${names.map((x) => x.en).join(', ')} over 28 days, with ${freeNext} free minutes in those windows over the next two weeks.`),
      evidence: [...keys.map((k) => ev(c, 'capacity.occupancy', `slot:${k}`)), ev(c, 'capacity.free_minutes_next14')],
      hypotheses: [L('قد يعود الهدوء إلى توقيت لا يناسب العميلات أو لعدم معرفتهن بتوفر المواعيد.', 'Quiet times may reflect timing that does not suit customers or that they do not know slots are available.')],
      target_volume: Math.max(1, Math.ceil((p.uplift_pp! * availNext) / dur)), baseline_volume: Math.round(quiet.reduce((m, s) => m + s.booked_min, 0) / 2 / dur),
      check_offering_id: offer?.id ?? null, goal_kinds: ['fill_quiet_times'], channels: ['in_app', 'whatsapp'], segment: consentedSegment(c),
      success_metrics: keys.map((k) => { const o = c.metrics.value('capacity.occupancy', `slot:${k}`); return { metric_key: `capacity.occupancy@slot:${k}`, baseline: o, target: o === null ? null : Math.min(0.9, Math.round((o + p.uplift_pp!) * 100) / 100) }; }),
      measurement_design: 'holdout', sample: { n: Math.round(quiet.reduce((m, s) => m + s.available_min, 0) / 60), min: 12 }, promotional: true,
      limitations: [L('الإشغال محسوب من الجداول والحجوزات المسجلة في لوما فقط.', 'Occupancy uses only the schedules and bookings recorded in LUMA.')],
      ...(fcNote.length ? { assumptions: fcNote } : {}),
      meta: { slots: keys, free_minutes: freeNext },
    })];
  },
};

export const highSatisfactionLowDemand: Detector = {
  id: 'high_satisfaction_low_demand', sectors: ['*'], requires: ['quality.rating_avg', 'sales.completed_count'], minQuality: { reviews: 'limited', sales: 'limited' },
  detect(c) {
    const p = c.params;
    const rated = c.ctx.activeServices.map((o) => ({ o, r: c.metrics.get('quality.rating_avg', `offering:${o.id}`) })).filter((x) => x.r?.value !== null && x.r !== undefined && x.r.n >= p.min_reviews!);
    const medRating = median(rated.map((x) => x.r!.value!)) ?? 0;
    const medDemand = median(c.ctx.activeServices.map((o) => completed(c, o.id))) ?? 0;
    return rated.filter((x) => x.r!.value! >= Math.max(medRating, 4) && (x.r!.value! >= p.min_rating! || rated.length > 1) && completed(c, x.o.id) <= medDemand)
      .sort((a, b) => b.r!.value! - a.r!.value! || a.o.id.localeCompare(b.o.id)).slice(0, 2).map(({ o, r }) => {
        const own = completed(c, o.id);
        const seg = customersOf(c, o.id);
        const others = new Set(c.ds.transactions.filter((t) => t.status === 'fulfilled').map((t) => t.customer_ref));
        const consented = new Set(c.ds.customers.filter((x) => Object.values(x.consents).some(Boolean)).map((x) => x.pseudo_id));
        const size = [...others].filter((x) => !seg.has(x) && consented.has(x)).length;
        return base(c, {
          detector_id: 'high_satisfaction_low_demand', category: 'high_satisfaction_low_demand', subject_key: `offering:${o.id}`, subject: { offering_ids: [o.id] },
          title: L(`إبراز ${o.name.ar}`, `Feature ${o.name.en}`),
          why_now: L(`تقييم ${r!.value!.toFixed(1)} من ${r!.n} تقييمات، وطلبها (${own} خلال ٩٠ يومًا) أقل من وسيط خدماتك (${medDemand}).`,
            `Rated ${r!.value!.toFixed(1)} from ${r!.n} reviews, while demand (${own} in 90 days) is below your services’ median (${medDemand}).`),
          evidence: [ev(c, 'quality.rating_avg', `offering:${o.id}`), ev(c, 'quality.rating_count', `offering:${o.id}`), ev(c, 'sales.completed_count', `offering:${o.id}`)],
          hypotheses: [L('قد تكون الخدمة غير ظاهرة بما يكفي في المتجر أو غير معروفة للعميلات الحاليات.', 'The service may not be visible enough on the storefront or known to current customers.')],
          target_volume: Math.max(2, Math.ceil(((medDemand - own) * 14) / 90)), baseline_volume: Math.round((own * 14) / 90),
          check_offering_id: o.id, goal_kinds: ['grow_offerings'], channels: ['storefront', 'instagram'],
          segment: { definition: { conditions: [{ type: 'not_visited_offering', offering_id: o.id }, { type: 'has_consent' }] }, size, size_status: size >= 10 ? 'counted' : 'insufficient' },
          success_metrics: [{ metric_key: `sales.completed_count@offering:${o.id}`, baseline: own, target: own + Math.max(2, Math.ceil(((medDemand - own) * 14) / 90)) }],
          measurement_design: 'pre_post_with_control', sample: { n: r!.n, min: p.min_reviews! }, promotional: true,
          limitations: [L('عدد التقييمات محدود والمقارنة قبل/بعد ليست سببية.', 'Review counts are limited and before/after comparisons are not causal.')],
        });
      });
  },
};

export const lapsedCohort: Detector = {
  id: 'lapsed_cohort', sectors: ['*'], requires: ['customers.cadence_days', 'customers.lapsed'], minQuality: { customers: 'limited' }, needsSegmentation: true,
  detect(c) {
    const p = c.params;
    return [...c.ctx.cadence].filter(([id, x]) => x.days !== null && x.lapsed.length >= p.min_lapsed! && c.ctx.offeringById.get(id)?.status === 'active')
      .sort((a, b) => b[1].lapsed.length - a[1].lapsed.length || a[0].localeCompare(b[0])).slice(0, 2).map(([id, x]) => {
        const o = c.ctx.offeringById.get(id)!;
        return base(c, {
          detector_id: 'lapsed_cohort', category: 'lapsed_cohort', subject_key: `offering:${id}`, subject: { offering_ids: [id] },
          title: L(`استعادة عميلات ${o.name.ar}`, `Bring back ${o.name.en} customers`),
          why_now: L(`${x.lapsed.length} عميلة تجاوزن ١٫٥ ضعف دورة العودة المعتادة (${Math.round(x.days!)} يومًا) دون حجز قادم.`,
            `${x.lapsed.length} customers are past 1.5× the usual return interval (${Math.round(x.days!)} days) with no upcoming booking.`),
          evidence: [ev(c, 'customers.lapsed', `offering:${id}`), ev(c, 'customers.cadence_days', `offering:${id}`)],
          hypotheses: [L('قد يكون التأخر لانشغال أو انتقال لمنافس أو نسيان.', 'The delay may come from being busy, switching to a competitor, or forgetting.')],
          target_volume: Math.max(1, Math.ceil(x.lapsed.length * p.response_share!)), baseline_volume: 0,
          check_offering_id: id, goal_kinds: ['reactivate_customers'], channels: ['in_app', 'whatsapp', 'sms'],
          segment: { definition: { conditions: [{ type: 'due_for_offering', offering_id: id }, { type: 'has_consent' }] }, size: x.lapsed.length, size_status: 'counted' },
          success_metrics: [{ metric_key: `customers.lapsed@offering:${id}`, baseline: x.lapsed.length, target: Math.max(0, x.lapsed.length - Math.ceil(x.lapsed.length * p.response_share!)) }],
          measurement_design: 'holdout', sample: { n: x.n, min: 3 }, promotional: true,
          limitations: [L('الدورة محسوبة من الزيارات المكتملة المسجلة فقط.', 'The cycle uses only recorded completed visits.')],
        });
      });
  },
};

export const unservedDemand: Detector = {
  id: 'unserved_demand', sectors: ['*'], requires: ['demand.no_availability_30d', 'demand.waitlist_30d', 'capacity.occupancy_next14'], minQuality: {},
  detect(c) {
    const p = c.params;
    const out: OpportunityCandidate[] = [];
    for (const o of c.ctx.activeServices) {
      const signals = c.ctx.demand30('no_availability', o.id) + c.ctx.demand30('waitlist', o.id) + c.ctx.demand30('waitlist_entry', o.id);
      const res = new Set(c.ctx.qualifiedResources(o.id));
      const avail = c.ctx.minutes(['free', 'booked'], c.ctx.todayStart, c.ctx.horizonEnd, res);
      const booked = c.ctx.minutes(['booked'], c.ctx.todayStart, c.ctx.horizonEnd, res);
      const occ = avail > 0 ? booked / avail : null;
      const full = occ !== null && occ >= p.full_above!;
      if (!(signals >= p.min_signals! || (full && completed(c, o.id) >= 3))) continue;
      out.push(base(c, {
        detector_id: 'unserved_demand', category: 'unserved_demand', subject_key: `offering:${o.id}`, subject: { offering_ids: [o.id] },
        title: L(`طلب يفوق المتاح على ${o.name.ar}`, `Demand exceeds availability for ${o.name.en}`),
        why_now: full
          ? L(`مواعيد الأخصائيات المؤهلات لهذه الخدمة محجوزة بنسبة ${pct(occ)} في الأسبوعين القادمين${signals ? `، مع ${signals} طلب لم يجد موعدًا` : ''}.`, `Qualified specialists for this service are ${pct(occ)} booked over the next two weeks${signals ? `, with ${signals} requests that found no time` : ''}.`)
          : L(`${signals} مرة لم تجد العميلة موعدًا أو انضمت لقائمة الانتظار خلال ٣٠ يومًا.`, `${signals} times a customer found no time or joined the waitlist in 30 days.`),
        evidence: [ev(c, 'demand.no_availability_30d', `offering:${o.id}`), ev(c, 'demand.waitlist_30d', `offering:${o.id}`), ev(c, 'capacity.occupancy_next14')],
        hypotheses: [L('قد يكون توزيع الورديات لا يطابق أوقات الطلب.', 'Shift allocation may not match when demand happens.')],
        target_volume: signals || null, check_offering_id: o.id, goal_kinds: ['grow_offerings', 'increase_margin'], channels: ['in_store'],
        success_metrics: [{ metric_key: `demand.no_availability_30d@offering:${o.id}`, baseline: c.ctx.demand30('no_availability', o.id), target: 0 }],
        measurement_design: 'pre_post_with_control', sample: { n: Math.max(signals, completed(c, o.id)), min: p.min_signals! }, promotional: false,
        limitations: [L('إشارات عدم التوفر تأتي من زيارات المتجر فقط.', 'No-availability signals come from storefront visits only.')],
        meta: { occupancy_next14: occ, signals, no_prerequisite_conversion: true },
      }));
    }
    return out;
  },
};

export const conversionFriction: Detector = {
  id: 'conversion_friction', sectors: ['*'], requires: ['conversion.start_to_confirm_30d'], minQuality: { demand: 'limited' },
  detect(c) {
    const starts = c.ctx.demand30('booking_start');
    const s2c = c.metrics.value('conversion.start_to_confirm_30d');
    if (starts < c.params.min_starts! || s2c === null || s2c >= c.params.max_start_to_confirm!) return [];
    return [base(c, {
      detector_id: 'conversion_friction', category: 'conversion_friction', subject_key: 'business', title: L('تسهيل إتمام الحجز', 'Make booking easier to complete'),
      why_now: L(`بدأت ${starts} عملية حجز ولم يكتمل منها إلا ${pct(s2c)}.`, `${starts} bookings were started and only ${pct(s2c)} were confirmed.`),
      evidence: [ev(c, 'demand.booking_starts_30d'), ev(c, 'conversion.start_to_confirm_30d')],
      hypotheses: [L('قد تكون شروط الدفع أو العربون أو عدد الخطوات سبب التردد.', 'Payment or deposit terms, or the number of steps, may cause hesitation.')],
      goal_kinds: ['increase_conversion'], channels: ['storefront'], success_metrics: [{ metric_key: 'conversion.start_to_confirm_30d', baseline: s2c, target: Math.min(0.9, Math.round((s2c + 0.1) * 100) / 100) }],
      measurement_design: 'pre_post_with_control', sample: { n: starts, min: c.params.min_starts! },
      limitations: [L('يعتمد على أحداث المتجر غير المستبعدة فقط.', 'Based on non-excluded storefront events only.')],
    })];
  },
};

export const crossSellAffinity: Detector = {
  id: 'cross_sell_affinity', sectors: ['*'], requires: ['sales.completed_count'], minQuality: { sales: 'limited' }, needsSegmentation: true,
  detect(c) {
    const buyers = new Set(c.ds.transactions.filter((t) => t.status === 'fulfilled').map((t) => t.customer_ref));
    if (!buyers.size) return [];
    const sellable = new Set(c.ds.inventory.filter((i) => i.usage !== 'consumable' && i.offering_id).map((i) => i.offering_id!));
    const products = c.ctx.activeOfferings.filter((o) => o.kind === 'product' && (sellable.size === 0 || sellable.has(o.id)));
    let best: { prod: Offering; svc: Offering; lift: number; co: number; rateS: number; rate: number } | null = null;
    for (const prod of products) {
      const pb = customersOf(c, prod.id);
      if (pb.size < c.params.min_co_buyers!) continue;
      const rate = pb.size / buyers.size;
      for (const svc of c.ctx.activeServices) {
        const sc = customersOf(c, svc.id);
        if (sc.size < 5) continue;
        const co = [...sc].filter((x) => pb.has(x)).length;
        const rateS = co / sc.size;
        const lift = rate > 0 ? rateS / rate : 0;
        if (co >= c.params.min_co_buyers! && lift >= c.params.min_lift! && (!best || lift > best.lift)) best = { prod, svc, lift, co, rateS, rate };
      }
    }
    if (!best) return [];
    const { prod, svc, lift, co, rateS, rate } = best;
    return [base(c, {
      detector_id: 'cross_sell_affinity', category: 'cross_sell_affinity', subject_key: `pair:${svc.id}:${prod.id}`, subject: { offering_ids: [svc.id, prod.id] },
      title: L(`${prod.name.ar} مع ${svc.name.ar}`, `${prod.name.en} with ${svc.name.en}`),
      why_now: L(`${pct(rateS)} من عميلات ${svc.name.ar} اشترين ${prod.name.ar} مقابل ${pct(rate)} من جميع العميلات (×${lift.toFixed(1)}).`,
        `${pct(rateS)} of ${svc.name.en} customers bought ${prod.name.en} vs ${pct(rate)} of all customers (×${lift.toFixed(1)}).`),
      evidence: [ev(c, 'sales.completed_count', `offering:${prod.id}`), ev(c, 'sales.completed_count', `offering:${svc.id}`)],
      hypotheses: [L('قد يكون المنتج مكملًا طبيعيًا لنتيجة الخدمة.', 'The product may naturally complement the service result.')],
      target_volume: Math.max(1, Math.ceil(co * 0.2)), check_offering_id: prod.id, goal_kinds: ['sell_products'], channels: ['in_store', 'storefront'],
      segment: { definition: { conditions: [{ type: 'visited_offering', offering_id: svc.id }] }, size: customersOf(c, svc.id).size, size_status: 'counted' },
      success_metrics: [{ metric_key: `sales.completed_count@offering:${prod.id}`, baseline: completed(c, prod.id), target: completed(c, prod.id) + Math.max(1, Math.ceil(co * 0.2)) }],
      measurement_design: 'pre_post_with_control', sample: { n: co, min: c.params.min_co_buyers! }, promotional: true,
      limitations: [L('الارتباط لا يعني أن العرض المشترك سيزيد المبيعات.', 'Co-purchase does not mean a combined offer will increase sales.')],
      meta: { lift, service_id: svc.id, product_id: prod.id },
    })];
  },
};

export const slowMoverBundle: Detector = {
  id: 'slow_mover_bundle', sectors: ['*'], requires: ['inventory.slow_movers'], minQuality: { sales: 'limited' },
  detect(c) {
    // The partner is the most requested service whose margin is known and positive (§6.4).
    const top = [...c.ctx.activeServices].filter((o) => { const e = c.ctx.economics(o.id); return !!e && e.completeness >= c.ctx.settings.cost_completeness_threshold && (e.margin_minor ?? 0) > 0; })
      .sort((a, b) => completed(c, b.id) - completed(c, a.id) || a.id.localeCompare(b.id))[0];
    if (!top || completed(c, top.id) === 0) return [];
    return slowMovers(c.ctx).slice(0, 2).map((item) => {
      const prod = c.ctx.offeringById.get(item.offering_id!);
      return base(c, {
        detector_id: 'slow_mover_bundle', category: 'slow_mover_bundle', subject_key: `item:${item.id}`, subject: { offering_ids: [top.id, ...(prod ? [prod.id] : [])], item_ids: [item.id] },
        title: L(`تحريك ${item.name} مع ${top.name.ar}`, `Move ${item.name} with ${top.name.en}`),
        why_now: L(`${item.on_hand - item.reserved} وحدة من ${item.name} متاحة ومبيعاتها ${item.sold_90d} خلال ٩٠ يومًا، و${top.name.ar} أكثر خدماتك طلبًا.`,
          `${item.on_hand - item.reserved} units of ${item.name} on hand with ${item.sold_90d} sold in 90 days, and ${top.name.en} is your most requested service.`),
        evidence: [ev(c, 'inventory.on_hand', `item:${item.id}`), ev(c, 'inventory.days_of_cover', `item:${item.id}`), ev(c, 'sales.completed_count', `offering:${top.id}`)],
        hypotheses: [L('قد يكون المنتج غير معروض بالقرب من الخدمة المناسبة.', 'The product may not be presented next to the right service.')],
        target_volume: Math.min(item.on_hand - item.reserved, Math.max(1, Math.ceil((completed(c, top.id) * 14) / 90 * 0.2))), check_offering_id: top.id,
        goal_kinds: ['sell_products'], channels: ['in_store', 'storefront'], measurement_design: 'pre_post_with_control',
        success_metrics: [{ metric_key: `inventory.weekly_usage@item:${item.id}`, baseline: c.metrics.value('inventory.weekly_usage', `item:${item.id}`), target: null }],
        sample: { n: completed(c, top.id), min: 5 }, promotional: true,
        limitations: [L('أصناف التشغيل (المواد) لا تُعرض للبيع أبدًا.', 'Consumable materials are never offered for sale.')],
        meta: { item_id: item.id, product_offering_id: prod?.id ?? null, top_service_id: top.id },
      });
    });
  },
};

export const marginLeak: Detector = {
  id: 'margin_leak', sectors: ['*'], requires: ['econ.unit_margin_ratio'], minQuality: {},
  detect(c) {
    return c.ctx.activeOfferings.filter((o) => o.kind === 'service' || o.kind === 'product').flatMap((o) => {
      const e = c.ctx.economics(o.id)!;
      if (e.completeness < c.ctx.settings.cost_completeness_threshold || e.margin_ratio === null || e.margin_ratio >= c.params.thin_below! || e.sales_n < 1) return [];
      return [base(c, {
        detector_id: 'margin_leak', category: 'margin_leak', subject_key: `offering:${o.id}`, subject: { offering_ids: [o.id] },
        title: L(`هامش منخفض في ${o.name.ar}`, `Low margin on ${o.name.en}`),
        why_now: L(`هامش المساهمة للوحدة ${pct(e.margin_ratio)} بعد المواد والعمولة${e.platform_fee_minor ? ' وعمولة السوق' : ''}.`, `Unit contribution margin is ${pct(e.margin_ratio)} after materials and commission${e.platform_fee_minor ? ' and marketplace fees' : ''}.`),
        evidence: [ev(c, 'econ.unit_margin_ratio', `offering:${o.id}`), ev(c, 'econ.unit_contribution_margin', `offering:${o.id}`), ev(c, 'sales.completed_count', `offering:${o.id}`)],
        hypotheses: [L('قد تكون التكلفة المسجلة أو العمولة مرتفعة مقارنة بالسعر.', 'The recorded cost or commission may be high relative to the price.')],
        check_offering_id: o.id, goal_kinds: ['increase_margin'], channels: ['in_store'], measurement_design: 'observational',
        success_metrics: [{ metric_key: `econ.unit_margin_ratio@offering:${o.id}`, baseline: e.margin_ratio, target: c.params.thin_below! }],
        sample: { n: e.sales_n, min: 3 }, promotional: false,
        limitations: [L('يعتمد على دقة التكلفة المسجلة؛ رسوم الدفع غير محسوبة. أسعار المنافسين سياق فقط ولا تكفي وحدها لتغيير السعر.', 'Depends on the recorded cost; payment fees are not included. Competitor prices are context only and never enough on their own to change a price.')],
      })];
    });
  },
};

export const missingCostBlocker: Detector = {
  id: 'missing_cost_blocker', sectors: ['*'], requires: ['econ.cost_completeness'], minQuality: {},
  detect(c) {
    const missing = c.ctx.businessCostCompleteness.missing;
    if (!missing.length) return [];
    const ids = missing.map((o) => o.id).sort();
    const affected = missing.reduce((m, o) => m + completed(c, o.id), 0);
    return [base(c, {
      detector_id: 'missing_cost_blocker', category: 'missing_cost_blocker', subject_key: 'business', subject: { offering_ids: ids },
      title: L('تسجيل التكاليف الناقصة', 'Record missing costs'),
      why_now: L(`${missing.length} خدمات أو منتجات بلا تكلفة مكتملة (${affected} عملية بيع خلال ٩٠ يومًا)؛ لا يمكن الحكم على ربحية أي عرض عليها.`,
        `${missing.length} services or products lack complete costs (${affected} sales in 90 days); the profitability of any offer on them cannot be judged.`),
      evidence: [ev(c, 'econ.cost_completeness'), ...ids.slice(0, 5).map((id) => ev(c, 'econ.cost_completeness', `offering:${id}`))],
      goal_kinds: ['increase_margin'], channels: ['in_store'], measurement_design: 'observational',
      success_metrics: [{ metric_key: 'econ.cost_completeness', baseline: c.ctx.businessCostCompleteness.value, target: 1 }],
      sample: { n: Math.max(1, affected), min: 1 }, prerequisites: [],
      limitations: [], meta: { missing: ids, names: missing.map((o) => o.name) },
    })];
  },
};

export const offeringPresentation: Detector = {
  id: 'offering_presentation', sectors: ['*'], requires: ['demand.views_30d'], minQuality: { demand: 'limited' },
  detect(c) {
    return c.ctx.activeOfferings.filter((o) => c.ctx.demand30('view', o.id) >= c.params.min_views! && (!o.has_image || !o.has_description))
      .sort((a, b) => c.ctx.demand30('view', b.id) - c.ctx.demand30('view', a.id)).slice(0, 2).map((o) => base(c, {
        detector_id: 'offering_presentation', category: 'offering_presentation', subject_key: `offering:${o.id}`, subject: { offering_ids: [o.id] },
        title: L(`تحسين عرض ${o.name.ar}`, `Improve how ${o.name.en} is presented`),
        why_now: L(`${c.ctx.demand30('view', o.id)} مشاهدة خلال ٣٠ يومًا دون ${!o.has_image ? 'صورة' : 'وصف'}.`, `${c.ctx.demand30('view', o.id)} views in 30 days without a ${!o.has_image ? 'photo' : 'description'}.`),
        evidence: [ev(c, 'demand.views_30d', `offering:${o.id}`), ev(c, 'demand.booking_starts_30d', `offering:${o.id}`)],
        goal_kinds: ['increase_conversion', 'grow_offerings'], channels: ['storefront'], measurement_design: 'pre_post_with_control',
        success_metrics: [{ metric_key: `conversion.view_to_start_30d@offering:${o.id}`, baseline: c.metrics.value('conversion.view_to_start_30d', `offering:${o.id}`), target: null }],
        sample: { n: c.ctx.demand30('view', o.id), min: c.params.min_views! }, meta: { has_image: o.has_image, has_description: o.has_description },
      }));
  },
};

export const loyaltyOverDiscount: Detector = {
  id: 'loyalty_over_discount', sectors: ['*'], requires: ['econ.discount_share', 'customers.repeat_rate'], minQuality: { sales: 'limited' },
  detect(c) {
    const ds = c.metrics.value('econ.discount_share'), rr = c.metrics.value('customers.repeat_rate');
    if (ds === null || rr === null || ds < c.params.min_discount_share! || rr >= c.params.max_repeat! || c.ds.customers.length < c.params.min_customers!) return [];
    return [base(c, {
      detector_id: 'loyalty_over_discount', category: 'loyalty_over_discount', subject_key: 'business', title: L('ولاء بدل الخصومات المتكررة', 'Loyalty instead of repeated discounts'),
      why_now: L(`${pct(ds)} من المبيعات بخصم، ونسبة التكرار ${pct(rr)} فقط.`, `${pct(ds)} of sales carry a discount, while the repeat rate is only ${pct(rr)}.`),
      evidence: [ev(c, 'econ.discount_share'), ev(c, 'customers.repeat_rate')], goal_kinds: ['reactivate_customers', 'increase_margin'], channels: ['in_app'],
      success_metrics: [{ metric_key: 'customers.repeat_rate', baseline: rr, target: Math.min(1, Math.round((rr + 0.05) * 100) / 100) }],
      measurement_design: 'pre_post_with_control', sample: { n: c.ctx.sales90.length, min: 10 },
      limitations: [L('المقارنة قبل/بعد ليست سببية.', 'Before/after is not causal.')],
    })];
  },
};

export const campaignLearning: Detector = {
  id: 'campaign_learning', sectors: ['*'], requires: ['campaign.conversions'], minQuality: {},
  detect(c) {
    const cmp = c.ds.campaigns.filter((x) => x.targeted > 0 && ['sent', 'completed', 'sending'].includes(x.status)).sort((a, b) => (b.started_at ?? 0) - (a.started_at ?? 0))[0];
    if (!cmp) return [];
    const enough = cmp.targeted >= c.params.min_group! && cmp.holdout >= c.params.min_group!;
    return [base(c, {
      detector_id: 'campaign_learning', category: 'campaign_learning', subject_key: `campaign:${cmp.id}`, subject: { offering_ids: [], campaign_id: cmp.id },
      title: L('مراجعة نتيجة آخر حملة', 'Review the last campaign'),
      why_now: L(`${cmp.conversions} حجوزات منسوبة من ${cmp.targeted} رسالة.`, `${cmp.conversions} attributed bookings from ${cmp.targeted} messages.`),
      evidence: [ev(c, 'campaign.conversions', `campaign:${cmp.id}`), ev(c, 'campaign.attributed_net', `campaign:${cmp.id}`)],
      goal_kinds: [], channels: [cmp.channel === 'push' ? 'in_app' : (cmp.channel as 'in_app')].filter((x) => ['in_app', 'whatsapp', 'sms', 'email'].includes(x)),
      success_metrics: [{ metric_key: `campaign.incremental_rate@campaign:${cmp.id}`, baseline: null, target: null }],
      measurement_design: enough ? 'holdout' : 'observational', sample: { n: Math.min(cmp.targeted, cmp.holdout), min: c.params.min_group! },
      limitations: [enough ? L('المنسوب ليس إضافيًا؛ قارني بالمجموعة الضابطة.', 'Attributed is not incremental; compare with the holdout.') : L('العينة أصغر من ٣٠ في كل مجموعة؛ لا يُعرض أثر إضافي.', 'Fewer than 30 per group; no incremental effect is shown.')],
    })];
  },
};

export const DETECTORS: Detector[] = [quietCapacity, highSatisfactionLowDemand, lapsedCohort, unservedDemand, conversionFriction, crossSellAffinity,
  slowMoverBundle, marginLeak, missingCostBlocker, offeringPresentation, loyaltyOverDiscount, campaignLearning];

/** capacity_prerequisite is produced by the engine when a promising candidate is blocked (see opportunities/engine.ts). */
export const DERIVED_DETECTORS = ['capacity_prerequisite', 'seasonal_alignment'] as const;

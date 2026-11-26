import { L } from '../util/text';
import { median } from '../util/text';
import type { MetricContext } from './context';
import { defineMetric, type MetricPoint } from './registry';

/**
 * The v1 metric set (§6.3). Windows: lookback = the 90 local days before
 * today; "30d" = the 30 days before today; capacity past = 28 days; capacity
 * forward = today + 13 days. Every compute() is a pure function of the dataset.
 */
const ALL = ['*'];
const per = <T>(items: T[], ref: (x: T) => string, f: (x: T) => { value: number | null; n: number }): MetricPoint[] => items.map((x) => ({ grain_ref: ref(x), ...f(x) }));
const ratio = (a: number, b: number) => (b > 0 ? a / b : null);
const services = (c: MetricContext) => c.activeServices;
const offeringRef = (o: { id: string }) => `offering:${o.id}`;
const qtyOf = (c: MetricContext, id: string) => (c.salesLinesByOffering.get(id) ?? []).reduce((m, s) => m + s.line.qty, 0);
const netOf = (c: MetricContext, id: string) => (c.salesLinesByOffering.get(id) ?? []).reduce((m, s) => m + s.line.net_minor, 0);

// ── Sales ───────────────────────────────────────────────────────────────────
defineMetric({
  key: 'sales.completed_count', version: 1, label: L('المبيعات المكتملة (عدد)', 'Completed sales (count)'), unit: 'count', grain: ['business', 'offering'],
  window: 'P90D', formula: 'count(transactions where status = fulfilled); per offering: sum(line qty)', requires: ['Transaction'], min_sample: 0, sectors: ALL, domain: 'sales',
  compute: (c) => [{ grain_ref: 'business', value: c.sales90.length, n: c.sales90.length },
    ...per(c.activeOfferings.filter((o) => o.kind === 'service' || o.kind === 'product'), offeringRef, (o) => ({ value: qtyOf(c, o.id), n: qtyOf(c, o.id) }))],
});
defineMetric({
  key: 'sales.completed_net', version: 1, label: L('المبيعات المكتملة (صافي)', 'Completed sales (net)'), unit: 'minor', grain: ['business', 'offering'],
  window: 'P90D', formula: 'sum(net_minor) of fulfilled transactions; net = after discount, before tax, after refunds', requires: ['Transaction'], min_sample: 0, sectors: ALL, domain: 'sales',
  compute: (c) => [{ grain_ref: 'business', value: c.sales90.reduce((m, t) => m + t.net_minor, 0), n: c.sales90.length },
    ...per(c.activeOfferings.filter((o) => o.kind === 'service' || o.kind === 'product'), offeringRef, (o) => ({ value: netOf(c, o.id), n: qtyOf(c, o.id) }))],
});
defineMetric({
  key: 'sales.avg_order_value', version: 1, label: L('متوسط قيمة الطلب', 'Average order value'), unit: 'minor', grain: ['business'],
  window: 'P90D', formula: 'sales.completed_net ÷ sales.completed_count', requires: ['Transaction'], min_sample: 5, sectors: ALL, domain: 'sales',
  compute: (c) => [{ grain_ref: 'business', value: ratio(c.sales90.reduce((m, t) => m + t.net_minor, 0), c.sales90.length), n: c.sales90.length }],
});
defineMetric({
  key: 'sales.channel_mix', version: 1, label: L('مزيج القنوات', 'Channel mix'), unit: 'ratio', grain: ['channel'],
  window: 'P90D', formula: 'fulfilled transactions per channel ÷ all fulfilled', requires: ['Transaction.channel'], min_sample: 5, sectors: ALL, domain: 'sales',
  compute: (c) => {
    const m = new Map<string, number>();
    for (const t of c.sales90) m.set(t.channel, (m.get(t.channel) ?? 0) + 1);
    return [...m].map(([ch, k]) => ({ grain_ref: `channel:${ch}`, value: ratio(k, c.sales90.length), n: c.sales90.length }));
  },
});

// ── Customers ───────────────────────────────────────────────────────────────
defineMetric({
  key: 'customers.total', version: 1, label: L('العملاء المسجلون', 'Customers on record'), unit: 'count', grain: ['business'],
  window: 'all', formula: 'count(customers)', requires: ['Customer'], min_sample: 0, sectors: ALL, domain: 'customers',
  compute: (c) => [{ grain_ref: 'business', value: c.ds.customers.length, n: c.ds.customers.length }],
});
defineMetric({
  key: 'customers.active_90d', version: 1, label: L('العملاء النشطون', 'Active customers'), unit: 'count', grain: ['business'],
  window: 'P90D', formula: 'distinct customers with a fulfilled transaction in the window', requires: ['Transaction'], min_sample: 0, sectors: ALL, domain: 'customers',
  compute: (c) => { const n = new Set(c.sales90.map((t) => t.customer_ref)).size; return [{ grain_ref: 'business', value: n, n }]; },
});
defineMetric({
  key: 'customers.repeat_rate', version: 1, label: L('معدل التكرار', 'Repeat rate'), unit: 'ratio', grain: ['business'],
  window: 'all', formula: 'customers with ≥ 2 visits ÷ customers with ≥ 1 visit', requires: ['Customer.visits'], min_sample: 10, sectors: ALL, domain: 'customers',
  compute: (c) => { const v = c.ds.customers.filter((x) => x.visits >= 1); return [{ grain_ref: 'business', value: ratio(v.filter((x) => x.visits >= 2).length, v.length), n: v.length }]; },
});
defineMetric({
  key: 'customers.cadence_days', version: 1, label: L('الدورة الوسيطة بين الزيارات', 'Median days between visits'), unit: 'days', grain: ['offering'],
  window: 'P730D', formula: 'median gap (≥ 1 day) between consecutive fulfilled visits of the same customer for the offering', requires: ['Transaction'], min_sample: 3, sectors: ALL, domain: 'customers',
  compute: (c) => [...c.cadence].map(([id, x]) => ({ grain_ref: `offering:${id}`, value: x.days, n: x.n })),
});
defineMetric({
  key: 'customers.lapsed', version: 1, label: L('عملاء متأخرون عن دورتهم', 'Customers past their cycle'), unit: 'count', grain: ['offering'],
  window: 'P730D', formula: 'customers whose last visit < now − 1.5 × cadence_days and who have no upcoming booking', requires: ['customers.cadence_days'], min_sample: 3, sectors: ALL, domain: 'customers',
  compute: (c) => [...c.cadence].map(([id, x]) => ({ grain_ref: `offering:${id}`, value: x.days === null ? null : x.lapsed.length, n: x.n })),
});
defineMetric({
  key: 'customers.acquisition_mix', version: 1, label: L('مصادر الاكتساب', 'Acquisition sources'), unit: 'ratio', grain: ['source'],
  window: 'all', formula: 'customers per acquisition_source ÷ customers with a recorded source', requires: ['Customer.acquisition_source'], min_sample: 10, sectors: ALL, domain: 'customers',
  compute: (c) => {
    const known = c.ds.customers.filter((x) => x.acquisition_source);
    const m = new Map<string, number>();
    for (const x of known) m.set(x.acquisition_source!, (m.get(x.acquisition_source!) ?? 0) + 1);
    return [...m].map(([s, k]) => ({ grain_ref: `source:${s}`, value: ratio(k, known.length), n: known.length }));
  },
});
defineMetric({
  key: 'customers.consented', version: 1, label: L('عملاء بموافقة تسويقية', 'Customers with marketing consent'), unit: 'count', grain: ['business', 'channel'],
  window: 'all', formula: 'customers whose latest marketing consent for the channel is granted', requires: ['Customer.consents'], min_sample: 0, sectors: ALL, domain: 'customers',
  compute: (c) => {
    const ch = new Map<string, number>();
    for (const x of c.ds.customers) for (const [k, v] of Object.entries(x.consents)) if (v) ch.set(k, (ch.get(k) ?? 0) + 1);
    return [{ grain_ref: 'business', value: c.consentedCustomers, n: c.consentedCustomers }, ...[...ch].map(([k, v]) => ({ grain_ref: `channel:${k}`, value: v, n: v }))];
  },
});

// ── Quality ─────────────────────────────────────────────────────────────────
const closed = (c: MetricContext) => c.tx90.filter((t) => t.kind === 'booking' && ['fulfilled', 'cancelled_customer', 'cancelled_business', 'no_show'].includes(t.status));
defineMetric({
  key: 'quality.cancel_customer_rate', version: 1, label: L('الإلغاء من العميلة', 'Customer cancellations'), unit: 'ratio', grain: ['business'],
  window: 'P90D', formula: 'cancelled_customer ÷ (fulfilled + cancelled + no_show) bookings', requires: ['Transaction.status'], min_sample: 10, sectors: ALL, domain: 'sales',
  compute: (c) => { const all = closed(c); return [{ grain_ref: 'business', value: ratio(all.filter((t) => t.status === 'cancelled_customer').length, all.length), n: all.length }]; },
});
defineMetric({
  key: 'quality.no_show_rate', version: 1, label: L('عدم الحضور', 'No-shows'), unit: 'ratio', grain: ['business'],
  window: 'P90D', formula: 'no_show ÷ (fulfilled + cancelled + no_show) bookings', requires: ['Transaction.status'], min_sample: 10, sectors: ALL, domain: 'sales',
  compute: (c) => { const all = closed(c); return [{ grain_ref: 'business', value: ratio(all.filter((t) => t.status === 'no_show').length, all.length), n: all.length }]; },
});
defineMetric({
  key: 'quality.rating_avg', version: 1, label: L('متوسط التقييم', 'Average rating'), unit: 'rating', grain: ['business', 'offering'],
  window: 'P365D', formula: 'avg(rating) of verified reviews', requires: ['Review'], min_sample: 5, sectors: ALL, domain: 'reviews',
  compute: (c) => {
    const rs = c.ds.reviews.filter((r) => r.verified);
    const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
    const by = new Map<string, number[]>();
    for (const r of rs) if (r.offering_id) { const a = by.get(r.offering_id) ?? []; a.push(r.rating); by.set(r.offering_id, a); }
    return [{ grain_ref: 'business', value: avg(rs.map((r) => r.rating)), n: rs.length }, ...[...by].map(([id, xs]) => ({ grain_ref: `offering:${id}`, value: avg(xs), n: xs.length }))];
  },
});
defineMetric({
  key: 'quality.rating_count', version: 1, label: L('عدد التقييمات', 'Number of reviews'), unit: 'count', grain: ['business', 'offering'],
  window: 'P365D', formula: 'count(verified reviews)', requires: ['Review'], min_sample: 0, sectors: ALL, domain: 'reviews',
  compute: (c) => {
    const by = new Map<string, number>();
    for (const r of c.ds.reviews) if (r.verified && r.offering_id) by.set(r.offering_id, (by.get(r.offering_id) ?? 0) + 1);
    const n = c.ds.reviews.filter((r) => r.verified).length;
    return [{ grain_ref: 'business', value: n, n }, ...[...by].map(([id, k]) => ({ grain_ref: `offering:${id}`, value: k, n: k }))];
  },
});
defineMetric({
  key: 'quality.complaints_verified', version: 1, label: L('الشكاوى المؤكدة', 'Confirmed complaints'), unit: 'count', grain: ['business'],
  window: 'P90D', formula: 'count(complaints where verified)', requires: ['Complaint'], min_sample: 0, sectors: ALL, domain: 'reviews',
  compute: (c) => { const n = c.ds.complaints.filter((x) => x.verified && x.at >= c.lookbackStart).length; return [{ grain_ref: 'business', value: n, n }]; },
});

// ── Capacity ────────────────────────────────────────────────────────────────
defineMetric({
  key: 'capacity.occupancy', version: 1, label: L('الإشغال حسب اليوم والفترة', 'Occupancy by weekday and daypart'), unit: 'ratio', grain: ['business', 'slot'],
  window: 'P28D', formula: 'booked minutes ÷ available minutes (schedule − breaks − blocks − approved leave)', requires: ['CapacityWindow'], min_sample: 180, sectors: ALL, domain: 'capacity',
  compute: (c) => {
    const a = c.pastSlots.reduce((m, s) => m + s.available_min, 0), b = c.pastSlots.reduce((m, s) => m + s.booked_min, 0);
    return [{ grain_ref: 'business', value: ratio(b, a), n: a }, ...c.pastSlots.map((s) => ({ grain_ref: `slot:${s.key}`, value: s.occupancy, n: s.available_min }))];
  },
});
defineMetric({
  key: 'capacity.occupancy_resource', version: 1, label: L('الإشغال لكل مورد', 'Occupancy per resource'), unit: 'ratio', grain: ['resource'],
  window: 'P28D', formula: 'booked ÷ available minutes per resource', requires: ['CapacityWindow'], min_sample: 180, sectors: ALL, domain: 'capacity',
  compute: (c) => c.ds.resources.filter((r) => r.kind === 'staff' && r.active).map((r) => {
    const ids = new Set([r.id]);
    const a = c.minutes(['free', 'booked'], c.past28Start, c.todayStart, ids), b = c.minutes(['booked'], c.past28Start, c.todayStart, ids);
    return { grain_ref: `resource:${r.id}`, value: ratio(b, a), n: a };
  }),
});
defineMetric({
  key: 'capacity.free_minutes_next14', version: 1, label: L('الدقائق المتاحة في ١٤ يومًا', 'Free minutes, next 14 days'), unit: 'minutes', grain: ['business', 'day'],
  window: 'P14D-forward', formula: 'available − booked minutes from today to today + 13', requires: ['CapacityWindow'], min_sample: 0, sectors: ALL, domain: 'capacity',
  compute: (c) => {
    const tot = c.nextDays.reduce((m, d) => m + d.free_min, 0);
    return [{ grain_ref: 'business', value: tot, n: c.nextDays.reduce((m, d) => m + d.available_min, 0) }, ...c.nextDays.map((d) => ({ grain_ref: `day:${d.date}`, value: d.free_min, n: d.available_min }))];
  },
});
defineMetric({
  key: 'capacity.occupancy_next14', version: 1, label: L('المحجوز من الأيام الـ ١٤ القادمة', 'Already-booked share, next 14 days'), unit: 'ratio', grain: ['business', 'slot'],
  window: 'P14D-forward', formula: 'booked ÷ available minutes from today to today + 13', requires: ['CapacityWindow'], min_sample: 60, sectors: ALL, domain: 'capacity',
  compute: (c) => {
    const a = c.nextSlots.reduce((m, s) => m + s.available_min, 0), b = c.nextSlots.reduce((m, s) => m + s.booked_min, 0);
    return [{ grain_ref: 'business', value: ratio(b, a), n: a }, ...c.nextSlots.map((s) => ({ grain_ref: `slot:${s.key}`, value: s.occupancy, n: s.available_min }))];
  },
});
defineMetric({
  key: 'capacity.quiet_slots', version: 1, label: L('الفترات الهادئة', 'Quiet periods'), unit: 'count', grain: ['business'],
  window: 'P28D', formula: 'weekday×daypart slots with ≥ 180 available minutes and occupancy < 40%', requires: ['capacity.occupancy'], min_sample: 0, sectors: ALL, domain: 'capacity',
  compute: (c) => { const n = c.pastSlots.filter((s) => s.available_min >= 180 && (s.occupancy ?? 0) < 0.4).length; return [{ grain_ref: 'business', value: n, n: c.pastSlots.length }]; },
});
defineMetric({
  key: 'capacity.full_slots', version: 1, label: L('الفترات الممتلئة', 'Full periods'), unit: 'count', grain: ['business'],
  window: 'P14D-forward', formula: 'slots in the next 14 days with occupancy > 90%', requires: ['capacity.occupancy_next14'], min_sample: 0, sectors: ALL, domain: 'capacity',
  compute: (c) => { const n = c.nextSlots.filter((s) => (s.occupancy ?? 0) > 0.9).length; return [{ grain_ref: 'business', value: n, n: c.nextSlots.length }]; },
});

// ── Unserved demand & conversion ────────────────────────────────────────────
const demandMetric = (key: string, type: string[], label: ReturnType<typeof L>) => defineMetric({
  key, version: 1, label, unit: 'count', grain: ['business', 'offering'], window: 'P30D', formula: `count(demand signals of type ${type.join(' + ')})`,
  requires: ['DemandSignal'], min_sample: 0, sectors: ALL, domain: 'demand',
  compute: (c) => {
    const f = (id?: string) => type.reduce((m, t) => m + c.demand30(t, id), 0);
    const tot = f();
    return [{ grain_ref: 'business', value: tot, n: tot }, ...per(c.activeOfferings, offeringRef, (o) => { const v = f(o.id); return { value: v, n: v }; })];
  },
});
demandMetric('demand.no_availability_30d', ['no_availability'], L('«لا مواعيد»', 'No availability'));
demandMetric('demand.waitlist_30d', ['waitlist', 'waitlist_entry'], L('قائمة الانتظار', 'Waitlist demand'));
demandMetric('demand.views_30d', ['view'], L('المشاهدات', 'Views'));
demandMetric('demand.booking_starts_30d', ['booking_start'], L('بدء الحجز', 'Booking starts'));
defineMetric({
  key: 'demand.abandoned_starts_30d', version: 1, label: L('بدء حجز دون إتمام', 'Booking starts not completed'), unit: 'count', grain: ['business'],
  window: 'P30D', formula: 'max(0, booking starts − confirmed bookings)', requires: ['DemandSignal'], min_sample: 0, sectors: ALL, domain: 'demand',
  compute: (c) => { const s = c.demand30('booking_start'), k = c.demand30('confirmed'); return [{ grain_ref: 'business', value: Math.max(0, s - k), n: s }]; },
});
defineMetric({
  key: 'conversion.view_to_start_30d', version: 1, label: L('من المشاهدة إلى بدء الحجز', 'View → booking start'), unit: 'ratio', grain: ['business', 'offering'],
  window: 'P30D', formula: 'booking starts ÷ views', requires: ['DemandSignal'], min_sample: 20, sectors: ALL, domain: 'demand',
  compute: (c) => [{ grain_ref: 'business', value: ratio(c.demand30('booking_start'), c.demand30('view')), n: c.demand30('view') },
    ...per(c.activeOfferings, offeringRef, (o) => ({ value: ratio(c.demand30('booking_start', o.id), c.demand30('view', o.id)), n: c.demand30('view', o.id) }))],
});
defineMetric({
  key: 'conversion.start_to_confirm_30d', version: 1, label: L('من بدء الحجز إلى التأكيد', 'Booking start → confirmation'), unit: 'ratio', grain: ['business'],
  window: 'P30D', formula: 'confirmed (server events) ÷ booking starts', requires: ['DemandSignal'], min_sample: 20, sectors: ALL, domain: 'demand',
  compute: (c) => [{ grain_ref: 'business', value: ratio(c.demand30('confirmed'), c.demand30('booking_start')), n: c.demand30('booking_start') }],
});
defineMetric({
  key: 'conversion.visit_by_source', version: 1, label: L('التحويل حسب المصدر', 'Conversion by source'), unit: 'ratio', grain: ['source'],
  window: 'all', formula: 'customers with ≥ 1 visit ÷ customers, per acquisition source', requires: ['Customer'], min_sample: 5, sectors: ALL, domain: 'customers',
  compute: (c) => {
    const m = new Map<string, { n: number; v: number }>();
    for (const x of c.ds.customers) { if (!x.acquisition_source) continue; const a = m.get(x.acquisition_source) ?? { n: 0, v: 0 }; a.n++; if (x.visits > 0) a.v++; m.set(x.acquisition_source, a); }
    return [...m].map(([s, a]) => ({ grain_ref: `source:${s}`, value: ratio(a.v, a.n), n: a.n }));
  },
});

// ── Economics ───────────────────────────────────────────────────────────────
const sold = (c: MetricContext) => c.activeOfferings.filter((o) => o.kind === 'service' || o.kind === 'product');
const incomplete = (c: MetricContext, id: string) => (c.economics(id)?.completeness ?? 0) < c.settings.cost_completeness_threshold;
defineMetric({
  key: 'econ.unit_contribution_margin', version: 1, label: L('هامش المساهمة للوحدة', 'Unit contribution margin'), unit: 'minor', grain: ['offering'],
  window: 'P90D', formula: 'net_price − (material_cost + commission + payment_fee + platform_fee)', requires: ['CostFact.material', 'CostFact.commission'], min_sample: 0, sectors: ALL, domain: 'economics',
  compute: (c) => per(sold(c), offeringRef, (o) => { const e = c.economics(o.id)!; return { value: incomplete(c, o.id) ? null : e.margin_minor, n: e.sales_n, missing_input: incomplete(c, o.id) }; })
    .map((p) => ({ ...p, missing_input: p.missing_input || undefined })),
});
defineMetric({
  key: 'econ.unit_margin_ratio', version: 1, label: L('نسبة الهامش', 'Margin ratio'), unit: 'ratio', grain: ['offering'],
  window: 'P90D', formula: 'econ.unit_contribution_margin ÷ net_price', requires: ['CostFact.material', 'CostFact.commission'], min_sample: 0, sectors: ALL, domain: 'economics',
  compute: (c) => per(sold(c), offeringRef, (o) => { const e = c.economics(o.id)!; return { value: incomplete(c, o.id) ? null : e.margin_ratio, n: e.sales_n }; })
    .map((p) => ({ ...p, missing_input: p.value === null || undefined })),
});
defineMetric({
  key: 'econ.total_contribution_margin', version: 1, label: L('هامش المساهمة الإجمالي', 'Total contribution margin'), unit: 'minor', grain: ['business', 'offering'],
  window: 'P90D', formula: 'Σ unit_contribution_margin × quantity sold (offerings with complete costs only)', requires: ['CostFact.material', 'CostFact.commission'], min_sample: 0, sectors: ALL, domain: 'economics',
  compute: (c) => {
    const pts = per(sold(c), offeringRef, (o) => { const e = c.economics(o.id)!; return { value: incomplete(c, o.id) || e.margin_minor === null ? null : e.margin_minor * qtyOf(c, o.id), n: e.sales_n }; });
    const anyMissing = sold(c).some((o) => qtyOf(c, o.id) > 0 && incomplete(c, o.id));
    return [{ grain_ref: 'business', value: anyMissing ? null : pts.reduce((m, p) => m + (p.value ?? 0), 0), n: c.sales90.length, missing_input: anyMissing || undefined },
      ...pts.map((p) => ({ ...p, missing_input: p.value === null || undefined }))];
  },
});
defineMetric({
  key: 'econ.discount_share', version: 1, label: L('نسبة المبيعات بخصم', 'Share of sales with a discount'), unit: 'ratio', grain: ['business'],
  window: 'P90D', formula: 'fulfilled transactions with discount > 0 or a coupon ÷ fulfilled transactions', requires: ['Transaction.discount'], min_sample: 10, sectors: ALL, domain: 'sales',
  compute: (c) => [{ grain_ref: 'business', value: ratio(c.sales90.filter((t) => t.discount_minor > 0 || t.has_coupon).length, c.sales90.length), n: c.sales90.length }],
});
defineMetric({
  key: 'econ.commission_total', version: 1, label: L('العمولات', 'Staff commissions'), unit: 'minor', grain: ['business'],
  window: 'P90D', formula: 'Σ line net × commission rate of the payroll policy category', requires: ['CostFact.commission'], min_sample: 0, sectors: ALL, domain: 'economics',
  compute: (c) => {
    let v = 0;
    for (const [id, lines] of c.salesLinesByOffering) { const e = c.economics(id); if (e) v += lines.reduce((m, s) => m + (s.line.net_minor * e.commission_rate_bp) / 10_000, 0); }
    return [{ grain_ref: 'business', value: Math.round(v), n: c.sales90.length }];
  },
});
defineMetric({
  key: 'econ.platform_fees', version: 1, label: L('عمولة السوق', 'Marketplace commission'), unit: 'minor', grain: ['business'],
  window: 'P90D', formula: 'Σ platform_fee_minor of fulfilled transactions', requires: ['Transaction.platform_fee'], min_sample: 0, sectors: ALL, domain: 'economics',
  compute: (c) => [{ grain_ref: 'business', value: c.sales90.reduce((m, t) => m + t.platform_fee_minor, 0), n: c.sales90.length }],
});
defineMetric({
  key: 'econ.payment_fees', version: 1, label: L('رسوم الدفع', 'Payment fees'), unit: 'minor', grain: ['business'],
  window: 'P90D', formula: 'Σ payment processing fees (not tracked by the LUMA connector)', requires: ['CostFact.payment_fee'], min_sample: 0, sectors: ALL, domain: 'economics',
  compute: (c) => {
    const f = c.ds.costs.find((x) => x.type === 'payment_fee');
    return [{ grain_ref: 'business', value: null, n: 0, missing_input: !f || f.basis === 'not_tracked' }];
  },
});
defineMetric({
  key: 'econ.cost_completeness', version: 1, label: L('اكتمال التكاليف', 'Cost completeness'), unit: 'ratio', grain: ['business', 'offering'],
  window: 'P90D', formula: 'share of sales (revenue-weighted for the business) whose direct cost is known', requires: ['CostFact.material'], min_sample: 0, sectors: ALL, domain: 'economics',
  compute: (c) => [{ grain_ref: 'business', value: c.businessCostCompleteness.value, n: c.sales90.length },
    ...per(sold(c), offeringRef, (o) => { const e = c.economics(o.id)!; return { value: e.completeness, n: e.sales_n }; })],
});

// ── Inventory ───────────────────────────────────────────────────────────────
const weekly = (i: { consumed_90d: number; sold_90d: number }) => (i.consumed_90d + i.sold_90d) / (90 / 7);
defineMetric({
  key: 'inventory.on_hand', version: 1, label: L('المتاح', 'On hand'), unit: 'units', grain: ['item'],
  window: 'now', formula: 'on_hand − reserved', requires: ['InventoryItem'], min_sample: 0, sectors: ALL, domain: 'inventory',
  compute: (c) => c.ds.inventory.filter((i) => i.active).map((i) => ({ grain_ref: `item:${i.id}`, value: i.on_hand - i.reserved, n: 1 })),
});
defineMetric({
  key: 'inventory.weekly_usage', version: 1, label: L('الاستهلاك الأسبوعي', 'Weekly usage'), unit: 'units', grain: ['item'],
  window: 'P90D', formula: '(consumed + sold over 90 days) ÷ (90/7)', requires: ['InventoryItem'], min_sample: 0, sectors: ALL, domain: 'inventory',
  compute: (c) => c.ds.inventory.filter((i) => i.active).map((i) => ({ grain_ref: `item:${i.id}`, value: weekly(i), n: 1 })),
});
defineMetric({
  key: 'inventory.days_of_cover', version: 1, label: L('أيام التغطية', 'Days of cover'), unit: 'days', grain: ['item'],
  window: 'P90D', formula: 'available ÷ (weekly usage ÷ 7); null without usage', requires: ['inventory.weekly_usage'], min_sample: 0, sectors: ALL, domain: 'inventory',
  compute: (c) => c.ds.inventory.filter((i) => i.active).map((i) => ({ grain_ref: `item:${i.id}`, value: weekly(i) > 0 ? (i.on_hand - i.reserved) / (weekly(i) / 7) : null, n: 1 })),
});
defineMetric({
  key: 'inventory.slow_movers', version: 1, label: L('أصناف بطيئة الحركة (للبيع)', 'Slow-moving sellable items'), unit: 'count', grain: ['business'],
  window: 'P90D', formula: 'sellable items with stock and (no sales or > 180 days of cover); consumables never count', requires: ['InventoryItem'], min_sample: 0, sectors: ALL, domain: 'inventory',
  compute: (c) => { const n = slowMovers(c).length; return [{ grain_ref: 'business', value: n, n: c.ds.inventory.length }]; },
});

export function slowMovers(c: MetricContext) {
  return c.ds.inventory.filter((i) => i.active && i.usage !== 'consumable' && i.offering_id && i.on_hand - i.reserved > 0
    && (i.sold_90d === 0 || (i.on_hand - i.reserved) / (i.sold_90d / 90) > 180));
}

// ── Campaigns ───────────────────────────────────────────────────────────────
defineMetric({
  key: 'campaign.attributed_net', version: 1, label: L('الإيراد المنسوب للحملة', 'Attributed revenue'), unit: 'minor', grain: ['campaign'],
  window: 'campaign', formula: 'Σ converted value within the attribution window (attributed, not incremental)', requires: ['Campaign'], min_sample: 0, sectors: ALL, domain: 'campaigns',
  compute: (c) => c.ds.campaigns.map((x) => ({ grain_ref: `campaign:${x.id}`, value: x.attributed_net_minor, n: x.targeted })),
});
defineMetric({
  key: 'campaign.conversions', version: 1, label: L('التحويلات المنسوبة', 'Attributed conversions'), unit: 'count', grain: ['campaign'],
  window: 'campaign', formula: 'count(converted events)', requires: ['Campaign'], min_sample: 0, sectors: ALL, domain: 'campaigns',
  compute: (c) => c.ds.campaigns.map((x) => ({ grain_ref: `campaign:${x.id}`, value: x.conversions, n: x.targeted })),
});
defineMetric({
  key: 'campaign.incremental_rate', version: 1, label: L('الأثر الإضافي', 'Incremental effect'), unit: 'ratio', grain: ['campaign'],
  window: 'campaign', formula: 'conversion rate (target) − conversion rate (holdout), only with ≥ 30 in each group', requires: ['Campaign.holdout'], min_sample: 30, sectors: ALL, domain: 'campaigns',
  // Holdout conversions are not exported yet: honest "missing input", never an estimate.
  compute: (c) => c.ds.campaigns.map((x) => ({ grain_ref: `campaign:${x.id}`, value: null, n: Math.min(x.targeted, x.holdout), missing_input: true })),
});
defineMetric({
  key: 'campaign.cost', version: 1, label: L('تكلفة الحملة', 'Campaign cost'), unit: 'minor', grain: ['campaign'],
  window: 'campaign', formula: 'recorded campaign cost (null when not recorded); CAC = cost ÷ new customers', requires: ['Campaign.cost'], min_sample: 0, sectors: ALL, domain: 'campaigns',
  compute: (c) => c.ds.campaigns.map((x) => ({ grain_ref: `campaign:${x.id}`, value: x.cost_minor, n: x.targeted, missing_input: x.cost_minor === null || undefined })),
});

/** Median helper re-exported for detectors that compare an offering with its peers. */
export const medianOf = median;

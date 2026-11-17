import type { CanonicalDataset, Transaction } from '../contracts/canonical';
import { unitEconomics } from '../economics/unit';
import { L, round, type Localized } from '../util/text';
import { addDays, localDateOf, localToMs } from '../util/time';
import type { GoalMetric, MeasurementQuality } from './initiatives';

/**
 * Measurement (§10.3), pure. Generalises LUMA's campaign rule "attributed is
 * not incremental" to every initiative:
 *  - partitionable (a campaign with a randomised holdout): an incremental
 *    estimate only when BOTH groups have ≥ 30 members (MIN_GROUP_FOR_INCREMENTAL),
 *    otherwise `insufficient`; attributed results are always shown apart;
 *  - not partitionable (plan actions, price changes, content): pre/post with
 *    control offerings → `observational`, «إشارة محدودة لا علاقة سببية»;
 *  - guardrails: cancellations, refunds, occupancy overload vs ratings.
 * Quality `quasi` = a randomised holdout of sufficient size whose window was
 * contaminated by an external factor (stockout, price change of the offering,
 * another campaign) — the split holds but the estimate is weakened.
 */
export const MIN_GROUP_FOR_INCREMENTAL = 30;

export type Group = { members: number; converters: number; bookings: number; net_minor: number; cancelled: number; refunded_minor: number };
export type CampaignGroups = { campaign_id: string; window_days: number; started_at: number | null; target: Group | null; holdout: Group | null };
export type ExternalFactor = { type: 'concurrent_campaign' | 'stockout' | 'price_change' | 'capacity_change' | 'season'; ref: string; at: string | null; label: Localized; contaminates: boolean };

export type MeasureInput = {
  ds: CanonicalDataset;
  initiative: {
    offering_ids: string[]; window_from: string; window_to: string; artifact_kind: 'plan_action' | 'campaign_draft' | 'price_proposal'; artifact_ref: string;
    goal_metrics: GoalMetric[]; executed: boolean; actual_cost_minor: number | null;
  };
  groups: CampaignGroups | null;
  factors: ExternalFactor[];
};

export type Cell = { pre: number | null; post: number | null };
export type MetricResult = { key: GoalMetric; label: Localized; unit: 'count' | 'minor' | 'ratio'; target: Cell; control: Cell | null; change: number | null; estimate: number | null };
export type Guardrail = { key: 'cancellations' | 'refunds' | 'occupancy_overload' | 'rating'; label: Localized; pre: number | null; post: number | null; breached: boolean };

export type Outcome = {
  design: 'holdout' | 'pre_post_with_control' | 'observational';
  quality: MeasurementQuality;
  causal: boolean;
  primary: MetricResult[];
  guardrails: Guardrail[];
  attributed: { campaign_id: string; members: number; converters: number; bookings: number; net_minor: number } | null;
  incremental: { status: 'estimated'; conversion_rate_lift: number; net_minor: number; members: { target: number; holdout: number } }
    | { status: 'insufficient_sample'; min_group: number; members: { target: number; holdout: number } } | null;
  external_factors: ExternalFactor[];
  limitations: Localized[];
  learnings: Localized[];
  periods: { pre: { from: string; to: string }; post: { from: string; to: string } };
};

export const METRIC_LABEL: Record<GoalMetric, Localized> = {
  completed_bookings: L('الحجوزات المكتملة', 'Completed bookings'),
  contribution_margin: L('هامش المساهمة', 'Contribution margin'),
  cac: L('تكلفة اكتساب العميلة', 'Customer acquisition cost'),
  repeat: L('نسبة التكرار', 'Repeat rate'),
  reactivation: L('عميلات عُدن بعد انقطاع', 'Reactivated customers'),
  quiet_period_fill: L('إشغال الفترات', 'Period occupancy'),
  cross_sell: L('البيع المكمل', 'Cross-sell transactions'),
};
const UNIT: Record<GoalMetric, MetricResult['unit']> = { completed_bookings: 'count', contribution_margin: 'minor', cac: 'minor', repeat: 'ratio', reactivation: 'count', quiet_period_fill: 'ratio', cross_sell: 'count' };
export const NOT_CAUSAL = L('إشارة محدودة لا علاقة سببية', 'A limited signal, not a causal relationship');

const CANCELLED = new Set(['cancelled_customer', 'cancelled_business', 'no_show']);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

class Cells {
  private readonly tz: string;
  constructor(private readonly ds: CanonicalDataset) { this.tz = ds.business.timezone; }
  private inPeriod(ms: number, p: { from: string; to: string }) { const d = localDateOf(ms, this.tz); return d >= p.from && d <= p.to; }

  lines(p: { from: string; to: string }, set: Set<string>, pred: (t: Transaction) => boolean) {
    const out: Array<{ t: Transaction; qty: number; net: number; offering: string }> = [];
    for (const t of this.ds.transactions) {
      if (!pred(t)) continue;
      for (const l of t.lines) if (set.has(l.offering_id) && this.inPeriod(l.starts_at, p)) out.push({ t, qty: l.qty, net: l.net_minor, offering: l.offering_id });
    }
    return out;
  }
  completed(p: { from: string; to: string }, set: Set<string>) { return this.lines(p, set, (t) => t.status === 'fulfilled' && t.consistent).reduce((m, x) => m + x.qty, 0); }
  margin(p: { from: string; to: string }, set: Set<string>): number | null {
    let m = 0;
    for (const x of this.lines(p, set, (t) => t.status === 'fulfilled' && t.consistent)) {
      const o = this.ds.offerings.find((y) => y.id === x.offering);
      const v = o ? unitEconomics(this.ds, o, []).variable_minor : null;
      if (v === null) return null;
      m += x.net - v * x.qty;
    }
    return m;
  }
  private customersIn(p: { from: string; to: string }, set: Set<string>) { return [...new Set(this.lines(p, set, (t) => t.status === 'fulfilled').map((x) => x.t.customer_ref))]; }
  private priorVisit(customer: string, before: number) {
    let last: number | null = null;
    for (const t of this.ds.transactions) if (t.customer_ref === customer && t.status === 'fulfilled' && t.occurred_at < before && (last === null || t.occurred_at > last)) last = t.occurred_at;
    return last;
  }
  repeat(p: { from: string; to: string }, set: Set<string>): number | null {
    const cs = this.customersIn(p, set);
    if (!cs.length) return null;
    const start = localToMs(p.from, '00:00', this.tz);
    return round(cs.filter((c) => this.priorVisit(c, start) !== null).length / cs.length);
  }
  reactivation(p: { from: string; to: string }, set: Set<string>) {
    const start = localToMs(p.from, '00:00', this.tz);
    return this.customersIn(p, set).filter((c) => { const v = this.priorVisit(c, start); return v !== null && start - v > 90 * 86_400_000; }).length;
  }
  newCustomers(p: { from: string; to: string }, set: Set<string>) {
    const start = localToMs(p.from, '00:00', this.tz);
    return this.customersIn(p, set).filter((c) => this.priorVisit(c, start) === null).length;
  }
  crossSell(p: { from: string; to: string }, set: Set<string>) {
    const tx = new Set(this.lines(p, set, (t) => t.status === 'fulfilled').map((x) => x.t));
    return [...tx].filter((t) => new Set(t.lines.map((l) => l.offering_id)).size >= 2).length;
  }
  /** Booked ÷ (free + booked) for the staff qualified for the set, inside the known capacity horizon; null when the window is not covered. */
  occupancy(p: { from: string; to: string }, set: Set<string>): number | null {
    const staff = new Set(this.ds.requirements.filter((r) => set.has(r.offering_id) && r.type === 'skill' && r.ref_id).map((r) => r.ref_id!));
    if (!staff.size) return null;
    const s = localToMs(p.from, '00:00', this.tz), e = localToMs(addDays(p.to, 1), '00:00', this.tz);
    let free = 0, booked = 0;
    for (const w of this.ds.capacity) {
      if (!staff.has(w.resource_id) || (w.state !== 'free' && w.state !== 'booked')) continue;
      const a = Math.max(w.start, s), b = Math.min(w.end, e);
      if (b > a) { if (w.state === 'free') free += b - a; else booked += b - a; }
    }
    return free + booked > 0 ? round(booked / (free + booked)) : null;
  }
  cancellationRate(p: { from: string; to: string }, set: Set<string>): { rate: number | null; n: number } {
    const all = this.lines(p, set, (t) => t.status === 'fulfilled' || CANCELLED.has(t.status));
    const c = all.filter((x) => CANCELLED.has(x.t.status)).length;
    return { rate: all.length ? round(c / all.length) : null, n: c };
  }
  refunds(p: { from: string; to: string }, set: Set<string>) {
    return [...new Set(this.lines(p, set, () => true).map((x) => x.t))].reduce((m, t) => m + t.refunded_minor, 0);
  }
  rating(p: { from: string; to: string }, set: Set<string>): number | null {
    const rs = this.ds.reviews.filter((r) => r.offering_id && set.has(r.offering_id) && this.inPeriod(r.at, p));
    return rs.length ? round(rs.reduce((m, r) => m + r.rating, 0) / rs.length, 2) : null;
  }
}

function metric(c: Cells, key: GoalMetric, p: { from: string; to: string }, set: Set<string>, cost: number | null): number | null {
  switch (key) {
    case 'completed_bookings': return c.completed(p, set);
    case 'contribution_margin': return c.margin(p, set);
    case 'cac': { const n = c.newCustomers(p, set); return cost !== null && n > 0 ? Math.round(cost / n) : null; }
    case 'repeat': return c.repeat(p, set);
    case 'reactivation': return c.reactivation(p, set);
    case 'quiet_period_fill': return c.occupancy(p, set);
    case 'cross_sell': return c.crossSell(p, set);
  }
}

export function measureInitiative(input: MeasureInput): Outcome {
  const { ds, initiative: i } = input;
  const c = new Cells(ds);
  const len = Math.max(1, daysBetween(i.window_from, i.window_to) + 1);
  const post = { from: i.window_from, to: i.window_to };
  const pre = { from: addDays(i.window_from, -len), to: addDays(i.window_from, -1) };
  const target = new Set(i.offering_ids);
  const control = new Set(ds.offerings.filter((o) => o.kind === 'service' && o.status === 'active' && !target.has(o.id)).map((o) => o.id));
  const limitations: Localized[] = [];
  const learnings: Localized[] = [];
  const metrics = (i.goal_metrics.length ? i.goal_metrics : ['completed_bookings' as GoalMetric]);

  const primary: MetricResult[] = metrics.map((key) => {
    // CAC is a cost per new customer of THIS initiative: no pre period.
    const t: Cell = { pre: key === 'cac' ? null : metric(c, key, pre, target, null), post: metric(c, key, post, target, i.actual_cost_minor) };
    const ctl: Cell | null = control.size && key !== 'cac' ? { pre: metric(c, key, pre, control, null), post: metric(c, key, post, control, null) } : null;
    const change = t.pre !== null && t.post !== null ? round(t.post - t.pre) : null;
    // Difference-in-differences against the control offerings (a descriptive estimate, never causal).
    const estimate = change !== null && ctl && ctl.pre !== null && ctl.post !== null && ctl.pre !== 0 && UNIT[key] !== 'ratio'
      ? round(t.post! - t.pre! * (ctl.post / ctl.pre)) : change !== null && ctl && ctl.pre !== null && ctl.post !== null && UNIT[key] === 'ratio' ? round(change - (ctl.post - ctl.pre)) : null;
    return { key, label: METRIC_LABEL[key], unit: UNIT[key], target: t, control: ctl, change, estimate };
  });

  // Guardrails.
  const canc = { pre: c.cancellationRate(pre, target), post: c.cancellationRate(post, target) };
  const ref = { pre: c.refunds(pre, target), post: c.refunds(post, target) };
  const occ = c.occupancy(post, target);
  const rat = { pre: c.rating(pre, target), post: c.rating(post, target) };
  const ratingDrop = rat.pre !== null && rat.post !== null ? rat.pre - rat.post : 0;
  const guardrails: Guardrail[] = [
    { key: 'cancellations', label: L('نسبة الإلغاء وعدم الحضور', 'Cancellation and no-show rate'), pre: canc.pre.rate, post: canc.post.rate,
      breached: canc.post.n >= 3 && canc.post.rate !== null && canc.post.rate - (canc.pre.rate ?? 0) > 0.1 },
    { key: 'refunds', label: L('المبالغ المستردة', 'Refunds'), pre: ref.pre, post: ref.post, breached: ref.post > 0 && ref.post > ref.pre * 1.5 },
    { key: 'occupancy_overload', label: L('ضغط الإشغال', 'Occupancy overload'), pre: null, post: occ, breached: occ !== null && occ > 0.9 },
    { key: 'rating', label: L('متوسط التقييم', 'Average rating'), pre: rat.pre, post: rat.post, breached: ratingDrop >= 0.5 || (occ !== null && occ > 0.9 && ratingDrop >= 0.3) },
  ];

  // External factors detected from the data inside the window.
  const factors = [...input.factors];
  for (const k of ds.campaigns) {
    if (k.id === i.artifact_ref || !k.started_at) continue;
    const d = localDateOf(k.started_at, ds.business.timezone);
    if (d >= post.from && d <= post.to) factors.push({ type: 'concurrent_campaign', ref: k.id, at: d, label: L('حملة أخرى أُرسلت خلال النافذة', 'Another campaign was sent during the window'), contaminates: true });
  }
  for (const e of ds.calendar) if (e.starts_on <= post.to && e.ends_on >= post.from) factors.push({ type: 'season', ref: e.id, at: e.starts_on, label: L(`مناسبة متزامنة: ${e.title}`, `Concurrent event: ${e.title}`), contaminates: false });

  let design: Outcome['design'] = i.artifact_kind === 'campaign_draft' ? 'holdout' : 'pre_post_with_control';
  let quality: MeasurementQuality;
  let attributed: Outcome['attributed'] = null;
  let incremental: Outcome['incremental'] = null;
  const g = input.groups;
  if (i.artifact_kind === 'campaign_draft' && g && g.target) {
    const t = g.target, h = g.holdout ?? { members: 0, converters: 0, bookings: 0, net_minor: 0, cancelled: 0, refunded_minor: 0 };
    attributed = { campaign_id: g.campaign_id, members: t.members, converters: t.converters, bookings: t.bookings, net_minor: t.net_minor };
    const members = { target: t.members, holdout: h.members };
    if (t.members >= MIN_GROUP_FOR_INCREMENTAL && h.members >= MIN_GROUP_FOR_INCREMENTAL) {
      const lift = round(t.converters / t.members - h.converters / h.members);
      incremental = { status: 'estimated', conversion_rate_lift: lift, net_minor: Math.round(t.net_minor - h.net_minor * (t.members / h.members)), members };
      quality = factors.some((f) => f.contaminates) ? 'quasi' : 'experimental';
      learnings.push(lift > 0
        ? L(`أثر إضافي مقاس: نسبة التحويل أعلى بـ ${(lift * 100).toFixed(1)} نقطة من مجموعة الضبط.`, `Measured incremental effect: conversion ${(lift * 100).toFixed(1)} points above the holdout.`)
        : L('لا أثر إضافي مقاس مقارنة بمجموعة الضبط؛ لا تُكرر الحملة بنفس الصيغة دون تعديل.', 'No measured incremental effect against the holdout; do not repeat the campaign unchanged.'));
      if (quality === 'quasi') limitations.push(L('عوامل خارجية خلال النافذة تُضعف التقدير.', 'External factors during the window weaken the estimate.'));
    } else {
      incremental = { status: 'insufficient_sample', min_group: MIN_GROUP_FOR_INCREMENTAL, members };
      quality = 'insufficient';
      limitations.push(L(`لا يُقدَّر الأثر الإضافي: كل مجموعة تحتاج ${MIN_GROUP_FOR_INCREMENTAL} عضوًا على الأقل (الهدف ${t.members}، الضبط ${h.members}).`,
        `No incremental estimate: each group needs at least ${MIN_GROUP_FOR_INCREMENTAL} members (target ${t.members}, holdout ${h.members}).`));
      learnings.push(L('العينة غير كافية للحكم على الحملة؛ النتيجة المنسوبة ليست أثرًا إضافيًا.', 'The sample is too small to judge the campaign; attributed results are not incremental.'));
    }
    limitations.push(L('النتيجة المنسوبة ليست أثرًا إضافيًا.', 'Attributed results are not incremental.'));
  } else if (i.artifact_kind === 'campaign_draft') {
    quality = 'insufficient';
    limitations.push(L('لم تُرسل الحملة أو لا توجد مجموعة مستهدفة مسجّلة.', 'The campaign was not sent or has no recorded target group.'));
    learnings.push(L('لا نتيجة: الحملة لم تُنفَّذ.', 'No result: the campaign was not executed.'));
  } else {
    design = 'pre_post_with_control';
    const cb = primary.find((m) => m.key === 'completed_bookings') ?? primary[0]!;
    const volume = (cb.target.pre ?? 0) + (cb.target.post ?? 0);
    quality = volume > 0 || primary.some((m) => m.target.post !== null && m.target.post !== 0) ? 'observational' : 'insufficient';
    limitations.push(NOT_CAUSAL);
    if (!control.size) limitations.push(L('لا توجد خدمات ضابطة؛ المقارنة قبل/بعد فقط.', 'No control offerings; a before/after comparison only.'));
    if (quality === 'observational') {
      learnings.push(L(`${cb.label.ar}: ${cb.target.pre ?? '—'} قبل ← ${cb.target.post ?? '—'} خلال النافذة${cb.control ? ` (الخدمات الضابطة ${cb.control.pre ?? '—'} ← ${cb.control.post ?? '—'})` : ''} — ${NOT_CAUSAL.ar}.`,
        `${cb.label.en}: ${cb.target.pre ?? '—'} before → ${cb.target.post ?? '—'} during the window${cb.control ? ` (control offerings ${cb.control.pre ?? '—'} → ${cb.control.post ?? '—'})` : ''} — ${NOT_CAUSAL.en}.`));
    } else learnings.push(L('لا توجد بيانات كافية في الفترتين للمقارنة.', 'There is not enough data in either period to compare.'));
  }
  if (!i.executed) {
    quality = 'insufficient';
    limitations.push(L('لم يُسجَّل تنفيذ لهذه المبادرة؛ لا تُنسب إليها نتيجة.', 'No execution was recorded for this initiative; no result is attributed to it.'));
  }
  for (const gr of guardrails.filter((x) => x.breached)) learnings.push(L(`تجاوز حاجز أمان: ${gr.label.ar}.`, `Guardrail breached: ${gr.label.en}.`));
  if (factors.length) limitations.push(L('عوامل خارجية متزامنة مذكورة مع النتيجة.', 'Concurrent external factors are listed with the result.'));
  if (primary.some((m) => m.key === 'contribution_margin' && m.target.post === null)) limitations.push(L('التكاليف ناقصة؛ لا يُحسب هامش المساهمة.', 'Costs are incomplete; contribution margin is not computed.'));
  return { design, quality, causal: quality === 'experimental', primary, guardrails, attributed, incremental, external_factors: factors, limitations, learnings, periods: { pre, post } };
}

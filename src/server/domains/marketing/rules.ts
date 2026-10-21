import { addDays } from '../analytics/period';
import { WEEKDAYS } from '@/shared/format';
import type { PlanContent } from '@/shared/schemas/marketing';
import type { SnapshotData } from './snapshot';
import type { RecDraft } from './types';
import { marginFor } from './validate';

/**
 * Deterministic, explainable rules. Used when AI is disconnected, over budget,
 * or the owner asks for a rules-based plan; also the honest baseline the AI
 * output is compared against. Rules never forecast: targets are proposals.
 */

export const RULES_VERSION = 'rules-v1';

type Ctx = { d: SnapshotData; L: (ar: string, en: string) => string; today: string };
const pct = (x: number | null | undefined) => (x == null ? '—' : `${Math.round(x * 100)}%`);
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)]! : 0; };

const DAYPART = { morning: ['الصباح', 'morning'], afternoon: ['الظهيرة', 'afternoon'], evening: ['المساء', 'evening'] } as const;
const MISSING_TEXT: Record<string, [string, string]> = {
  active_services: ['لا توجد خدمات نشطة', 'No active services'],
  working_schedule: ['لا يوجد جدول عمل للفريق', 'No team working schedule'],
  booking_history: ['سجل الحجوزات المكتملة قليل (أقل من ١٠ خلال ٩٠ يوماً)', 'Little completed-booking history (fewer than 10 in 90 days)'],
  service_costs: ['تكاليف بعض الخدمات غير مسجلة — لا يمكن تقييم الهوامش', 'Some service costs are not recorded — margins cannot be assessed'],
  verified_calendar: ['لا يوجد تقويم مواسم ومناسبات موثّق — لم تُقترح تواريخ موسمية', 'No verified seasons/events calendar — no seasonal dates were proposed'],
  trend_sources: ['لا توجد مصادر اتجاهات متصلة', 'No trend sources connected'],
  storefront_traffic: ['زيارات المتجر قليلة لقياس التحويل بثقة', 'Too few storefront sessions to measure conversion reliably'],
};

export function missingText(locale: 'ar' | 'en', key: string) {
  const t = MISSING_TEXT[key];
  return t ? (locale === 'ar' ? t[0] : t[1]) : key;
}

function preferredChannel(d: SnapshotData): string {
  const order = ['in_app', 'whatsapp', 'sms', 'email'];
  return order.find((c) => d.preferences.channels.includes(c)) ?? order.find((c) => (d.customers.consented[c] ?? 0) > 0) ?? 'storefront';
}

function metric(d: SnapshotData, key: string) {
  return { value: d.metrics[key]?.value ?? null, supported: key in d.metrics };
}

function base(ctx: Ctx, r: Partial<RecDraft> & Pick<RecDraft, 'title' | 'category' | 'fingerprint' | 'opportunity' | 'suggested_action' | 'evidence_refs'>): RecDraft {
  const { d } = ctx;
  return {
    horizon: 'ongoing', period_start: null, period_end: null,
    measured_metrics: Object.fromEntries(r.evidence_refs.map((k) => [k, metric(d, k)])),
    timing: ctx.L('خلال الأسبوعين القادمين', 'Within the next two weeks'),
    estimated_cost: { status: 'unknown', amount_minor: null, assumptions: ctx.L('لم تُقدّر التكلفة؛ تعتمد على القناة والمحتوى.', 'Not estimated; depends on channel and content.') },
    capacity_check: { status: 'not_applicable' },
    margin_check: { status: 'not_applicable' },
    draft_content: null, channel: null, prerequisites: [],
    success_metric: '', experiment_design: '', confidence: d.sufficiency.level === 'ok' ? 'medium' : 'low',
    limitations: '', proposed_target: null, forecast: null, service_ids: [], validation: { status: 'rules' },
    ...r,
  } as RecDraft;
}

export function rulesRecommendations(d: SnapshotData): RecDraft[] {
  const L = (ar: string, en: string) => (d.business.locale === 'ar' ? ar : en);
  const ctx: Ctx = { d, L, today: d.period.today };
  const out: RecDraft[] = [];
  const free14 = d.metrics['capacity.next14.free_min']?.value ?? 0;
  const capOk = (needMin: number) => ({ status: free14 >= needMin ? 'ok' as const : free14 > 0 ? 'limited' as const : 'insufficient_capacity' as const, free_min_next14: free14 });
  const channel = preferredChannel(d);
  const wd = WEEKDAYS[d.business.locale];
  const full = d.capacity.buckets.filter((b) => b.occupancy >= 0.85).map((b) => b.key);

  // 1) Quiet periods — never promote slots that are already full.
  const quiet = d.capacity.buckets.filter((b) => b.available_min >= 180 && b.occupancy < 0.35).sort((a, b) => a.occupancy - b.occupancy).slice(0, 3);
  if (quiet.length && free14 > 0) {
    const names = quiet.map((q) => `${wd[q.weekday]} ${L(DAYPART[q.daypart][0], DAYPART[q.daypart][1])} (${pct(q.occupancy)})`).join('، ');
    out.push(base(ctx, {
      title: L('ملء الفترات الهادئة', 'Fill quiet periods'), category: 'quiet_periods', horizon: 'weekly',
      fingerprint: `quiet_periods:${quiet.map((q) => q.key).sort().join(',')}`,
      evidence_refs: [...quiet.map((q) => q.key), 'capacity.next14.free_min'],
      opportunity: L(`إشغال منخفض في: ${names}.`, `Low occupancy in: ${names}.`),
      suggested_action: L('روّجي لهذه الفترات فقط لعميلاتك الموافقات على التسويق، مع رابط حجز مباشر لتلك الأوقات. لا تروّجي للفترات الممتلئة.', 'Promote only these time windows to customers who consented to marketing, with a direct booking link for those times. Do not promote full slots.'),
      capacity_check: { ...capOk(60), avoided_full_slots: full }, channel,
      draft_content: { text: L('لدينا مواعيد متاحة هذا الأسبوع في أوقات هادئة ومريحة — احجزي موعدك بسهولة من المتجر.', 'We have relaxed appointment times available this week — book easily from our store.') },
      prerequisites: channel === 'storefront' ? [] : [L('قناة مفعّلة وموافقة تسويقية', 'An enabled channel and marketing consent')],
      success_metric: L('ارتفاع إشغال الفترات المستهدفة مقارنة بالأسابيع الأربعة السابقة', 'Occupancy of the targeted windows vs the previous four weeks'),
      experiment_design: L('أرسلي لمجموعة واحتفظي بمجموعة ضابطة (holdout) لم تُرسل لها الرسالة', 'Send to one group and keep a holdout group that does not receive it'),
      limitations: L('الإشغال محسوب من الجداول والحجوزات المسجلة فقط.', 'Occupancy is computed from recorded schedules and bookings only.'),
      proposed_target: L('رفع إشغال هذه الفترات بخمس نقاط مئوية (هدف مقترح وليس وعداً)', 'Raise these windows by five percentage points (a proposed goal, not a promise)'),
    }));
  }

  // 2) Reactivation using service-specific cadence.
  for (const s of [...d.services].filter((x) => x.due_customers >= 3 && x.cadence_days).sort((a, b) => b.due_customers - a.due_customers).slice(0, 2)) {
    out.push(base(ctx, {
      title: L(`استعادة عميلات ${s.name}`, `Bring back ${s.name} customers`), category: 'reactivation', horizon: 'weekly',
      fingerprint: `reactivation:${s.id}`, service_ids: [s.id],
      evidence_refs: [`service.${s.ref}.due_customers`, `service.${s.ref}.cadence_days`, 'capacity.next14.free_min'],
      opportunity: L(`${s.due_customers} عميلة تجاوزن موعد العودة المعتاد لهذه الخدمة (الوسيط ${Math.round(s.cadence_days!)} يوماً) دون حجز قادم.`,
        `${s.due_customers} customers are past their usual return interval for this service (median ${Math.round(s.cadence_days!)} days) with no upcoming booking.`),
      suggested_action: L('تذكير ودّي مخصص لهذه الخدمة للموافقات على التسويق فقط، دون خصم افتراضي.', 'A friendly, service-specific reminder to consenting customers only, without a default discount.'),
      capacity_check: capOk(s.due_customers * s.duration_min), channel,
      draft_content: { text: L(`حان وقت ${s.name} المعتاد؟ مواعيدنا متاحة هذا الأسبوع.`, `Time for your usual ${s.name}? We have openings this week.`), segment_definition: { conditions: [{ type: 'due_for_service', service_id: s.id }] }, service_ids: [s.id] },
      prerequisites: [L('قناة مفعّلة وموافقة تسويقية', 'An enabled channel and marketing consent')],
      success_metric: L('حجوزات مكتملة من المجموعة خلال نافذة الإسناد مقارنة بالمجموعة الضابطة', 'Completed bookings from the group within the attribution window vs the holdout'),
      experiment_design: L('مجموعة ضابطة ١٠٪ عند كفاية العدد', '10% holdout when the group is large enough'),
      limitations: L('الإيقاع محسوب من الزيارات المكتملة المسجلة فقط.', 'Cadence is based on recorded completed visits only.'),
    }));
  }

  // 3) Promote well-rated services with weak demand and free capacity.
  const medCompleted = median(d.services.map((s) => s.demand.completed));
  for (const s of d.services.filter((x) => (x.satisfaction.avg ?? 0) >= 4.5 && x.satisfaction.n >= 5 && x.demand.completed <= medCompleted).slice(0, 2)) {
    if (free14 <= 0) break;
    out.push(base(ctx, {
      title: L(`إبراز ${s.name}`, `Feature ${s.name}`), category: 'service_promotion', fingerprint: `service_promotion:${s.id}`, service_ids: [s.id],
      evidence_refs: [`service.${s.ref}.satisfaction_avg`, `service.${s.ref}.satisfaction_n`, `service.${s.ref}.completed_30d`, 'capacity.next14.free_min'],
      opportunity: L(`تقييم ${s.satisfaction.avg!.toFixed(1)} من ${s.satisfaction.n} مراجعات، والطلب أقل من بقية الخدمات مع وجود وقت متاح.`, `Rated ${s.satisfaction.avg!.toFixed(1)} from ${s.satisfaction.n} reviews, with lower demand than other services and free capacity.`),
      suggested_action: L('ضعيها في أعلى صفحة المتجر مع صور حقيقية وآراء العميلات.', 'Place it at the top of the storefront with real photos and customer reviews.'),
      capacity_check: capOk(s.duration_min * 3), channel: 'storefront',
      success_metric: L('مشاهدات وحجوزات الخدمة مقارنة بالشهر السابق', 'Service views and bookings vs the previous month'),
      experiment_design: L('قارني أسبوعين قبل وبعد مع ملاحظة أن المقارنة ليست سببية', 'Compare two weeks before/after, noting this is not causal'),
      limitations: L('عدد المراجعات محدود.', 'Review counts are limited.'),
    }));
  }

  // 4) Pricing as an ongoing review — never an automatic change.
  for (const s of d.services) {
    if (s.cost_status === 'known' && s.margin_ratio !== null && s.margin_ratio < 0.3) {
      out.push(base(ctx, {
        title: L(`مراجعة سعر/تكلفة ${s.name}`, `Review price/cost of ${s.name}`), category: 'pricing', fingerprint: `pricing:${s.id}:margin`, service_ids: [s.id],
        evidence_refs: [`service.${s.ref}.margin_ratio`, `service.${s.ref}.price_minor`],
        opportunity: L(`الهامش المسجّل ${pct(s.margin_ratio)} فقط.`, `Recorded margin is only ${pct(s.margin_ratio)}.`),
        suggested_action: L('راجعي التكلفة والسعر؛ يمكنكِ إنشاء اقتراح سعر يحتاج موافقتك ولا يُطبّق تلقائياً.', 'Review cost and price; you may create a price proposal that needs your approval and is never applied automatically.'),
        margin_check: marginFor([s], null),
        success_metric: L('هامش الخدمة بعد التعديل مع متابعة الطلب', 'Service margin after the change while monitoring demand'),
        experiment_design: L('غيّري سعراً واحداً وراقبي الطلب أربعة أسابيع', 'Change one price and monitor demand for four weeks'),
        limitations: L('يعتمد على دقة التكلفة المسجلة.', 'Depends on the accuracy of the recorded cost.'),
      }));
    }
    const pressure = s.demand.availability_empty + s.demand.waitlist;
    if (pressure >= 5 && (d.metrics['capacity.next14.occupancy']?.value ?? 0) >= 0.8) {
      out.push(base(ctx, {
        title: L(`طلب يفوق المتاح على ${s.name}`, `Demand exceeds availability for ${s.name}`), category: 'pricing', fingerprint: `pricing:${s.id}:demand`, service_ids: [s.id],
        evidence_refs: [`service.${s.ref}.availability_empty_30d`, `service.${s.ref}.waitlist_30d`, 'capacity.next14.occupancy'],
        opportunity: L('عميلات لم يجدن مواعيد أو انضممن لقائمة الانتظار مع إشغال مرتفع.', 'Customers found no availability or joined the waitlist while occupancy is high.'),
        suggested_action: L('قبل التوظيف: راجعي توزيع الورديات والتدريب وتخصيص الموارد، ثم فكّري في مراجعة السعر.', 'Before hiring: review shift allocation, training and resources, then consider a price review.'),
        margin_check: marginFor([s], null), capacity_check: capOk(0),
        success_metric: L('انخفاض لحظات عدم التوفر', 'Fewer no-availability moments'),
        experiment_design: L('عدّلي ورديات أسبوعين وقارني', 'Adjust shifts for two weeks and compare'),
        limitations: L('إشارات عدم التوفر تأتي من زيارات المتجر فقط.', 'No-availability signals come from storefront visits only.'),
      }));
    }
  }
  const noCost = d.services.filter((s) => s.cost_status === 'missing');
  if (noCost.length) {
    out.push(base(ctx, {
      title: L('سجّلي تكاليف الخدمات', 'Record service costs'), category: 'pricing', fingerprint: 'pricing:costs_missing',
      service_ids: noCost.map((s) => s.id), evidence_refs: noCost.slice(0, 5).map((s) => `service.${s.ref}.price_minor`),
      opportunity: L(`${noCost.length} خدمات بلا تكلفة مسجلة؛ لا يمكن الحكم على ربحية أي خصم أو باقة.`, `${noCost.length} services have no recorded cost; the profitability of any discount or package cannot be judged.`),
      suggested_action: L('أضيفي التكلفة التقريبية لكل خدمة من صفحة الخدمات.', 'Add an approximate cost for each service on the Services page.'),
      margin_check: { status: 'costs_incomplete', services_missing_costs: noCost.map((s) => s.ref) }, confidence: 'high',
      success_metric: L('اكتمال تكاليف الخدمات', 'All services have costs recorded'), experiment_design: L('غير مطبق', 'Not applicable'),
      limitations: '',
    }));
  }

  // 5) Packages / cross-sell with viable margins.
  const pair = d.pairs.find((p) => p.customers >= 3);
  if (pair) {
    const a = d.services.find((s) => s.ref === pair.a)!, b = d.services.find((s) => s.ref === pair.b)!;
    const m0 = marginFor([a, b], null);
    const discount = m0.status === 'ok' ? Math.min(d.preferences.max_discount_bp, 1000, Math.floor(((m0.min_margin_ratio ?? 0) - 0.2) * 10000)) : null;
    const mc = marginFor([a, b], discount && discount > 0 ? discount : null);
    out.push(base(ctx, {
      title: L(`باقة ${a.name} + ${b.name}`, `${a.name} + ${b.name} package`), category: 'packages', fingerprint: `packages:${[a.id, b.id].sort().join(':')}`, service_ids: [a.id, b.id],
      evidence_refs: [`pair.${pair.a}.${pair.b}.customers`, `service.${a.ref}.margin_ratio`, `service.${b.ref}.margin_ratio`],
      opportunity: L(`${pair.customers} عميلات حجزن الخدمتين خلال ١٨٠ يوماً.`, `${pair.customers} customers booked both services within 180 days.`),
      suggested_action: mc.status === 'costs_incomplete'
        ? L('اعرضي الخدمتين معاً دون خصم حتى تُسجّل التكاليف.', 'Offer the two services together without a discount until costs are recorded.')
        : discount && discount > 0 ? L(`باقة بخصم لا يتجاوز ${discount / 100}% ضمن حدودك.`, `A package with a discount of at most ${discount / 100}%, within your limits.`)
          : L('باقة بالسعر الكامل مع ميزة غير نقدية (مثل أولوية الحجز).', 'A full-price package with a non-cash perk (e.g. booking priority).'),
      margin_check: mc, capacity_check: capOk(a.duration_min + b.duration_min),
      success_metric: L('عدد الباقات المباعة وهامشها', 'Packages sold and their margin'), experiment_design: L('شهر تجريبي ثم مراجعة', 'One trial month, then review'),
      limitations: L('الارتباط بين الخدمتين لا يعني أن الباقة ستزيد الطلب.', 'Co-booking does not mean a package will increase demand.'),
    }));
  }

  // 6) Loyalty instead of perpetual discounts.
  const repeat = d.metrics['customers.repeat_share']?.value;
  if (d.customers.total >= 20 && repeat !== null && repeat !== undefined && repeat < 0.3) {
    out.push(base(ctx, {
      title: L('برنامج ولاء بدل الخصومات الدائمة', 'Loyalty instead of perpetual discounts'), category: 'loyalty', fingerprint: 'loyalty:repeat_share',
      evidence_refs: ['customers.repeat_share', 'customers.total'],
      opportunity: L(`نسبة العميلات المتكررات ${pct(repeat)}.`, `Repeat customers are ${pct(repeat)} of customers.`),
      suggested_action: L('فعّلي نقاط ولاء بسيطة تُكافئ الزيارة التالية بدلاً من خصم عام.', 'Enable simple loyalty points rewarding the next visit instead of a general discount.'),
      success_metric: L('نسبة العودة خلال ٩٠ يوماً', 'Return rate within 90 days'), experiment_design: L('قارني نسبة العودة قبل وبعد التفعيل', 'Compare return rate before/after enabling'),
      limitations: L('المقارنة قبل/بعد ليست سببية.', 'Before/after is not causal.'),
    }));
  }

  // 7) Booking experience.
  const starts = d.metrics['storefront.booking_starts_30d']?.value ?? 0;
  const s2c = d.metrics['storefront.start_to_confirm_30d']?.value;
  if (starts >= 20 && s2c !== null && s2c !== undefined && s2c < 0.3) {
    out.push(base(ctx, {
      title: L('تسهيل إتمام الحجز', 'Make booking easier to complete'), category: 'booking_experience', fingerprint: 'booking_experience:start_to_confirm',
      evidence_refs: ['storefront.booking_starts_30d', 'storefront.start_to_confirm_30d'],
      opportunity: L(`بدأت ${starts} عملية حجز ولم يكتمل إلا ${pct(s2c)}.`, `${starts} bookings were started and only ${pct(s2c)} completed.`),
      suggested_action: L('راجعي خطوات الحجز وشروط الدفع والعربون ووضوح الأسعار.', 'Review the booking steps, payment/deposit terms and price clarity.'),
      success_metric: L('نسبة إتمام الحجز', 'Booking completion rate'), experiment_design: L('غيّري عنصراً واحداً في كل مرة', 'Change one element at a time'),
      limitations: L('يعتمد على أحداث المتجر غير المستبعدة فقط.', 'Based on non-excluded storefront events only.'),
    }));
  }
  const empty = d.metrics['storefront.availability_empty_30d']?.value ?? 0;
  if (empty >= 5) {
    out.push(base(ctx, {
      title: L('عميلات لم يجدن مواعيد', 'Visitors finding no availability'), category: 'booking_experience', fingerprint: 'booking_experience:availability_empty',
      evidence_refs: ['storefront.availability_empty_30d', 'capacity.next14.free_min'],
      opportunity: L(`${empty} مرة لم تجد الزائرة موعداً متاحاً.`, `${empty} times a visitor found no available time.`),
      suggested_action: L('فعّلي قائمة الانتظار وراجعي الجداول قبل أي حملة.', 'Enable the waitlist and review schedules before any campaign.'),
      success_metric: L('انخفاض لحظات عدم التوفر', 'Fewer no-availability moments'), experiment_design: L('غير مطبق', 'Not applicable'),
      limitations: '',
    }));
  }

  // 8) Seasonal — only verified dates.
  for (const ev of d.calendar.events.filter((e) => e.starts_on >= ctx.today && e.starts_on <= addDays(ctx.today, 45)).slice(0, 2)) {
    out.push(base(ctx, {
      title: L(`الاستعداد لـ ${ev.title}`, `Prepare for ${ev.title}`), category: 'seasonal', horizon: 'monthly', period_start: ev.starts_on, period_end: ev.ends_on,
      fingerprint: `seasonal:${ev.title}:${ev.starts_on}`, evidence_refs: ['capacity.next14.free_min'],
      opportunity: L(`مناسبة موثّقة من قبلك تبدأ ${ev.starts_on}.`, `An event you verified starts on ${ev.starts_on}.`),
      suggested_action: L('خططي للمحتوى والمواعيد مسبقاً وتأكدي من التغطية التشغيلية.', 'Plan content and appointments early and confirm staff coverage.'),
      timing: L(`قبل ${ev.starts_on} بأسبوعين`, `Two weeks before ${ev.starts_on}`), capacity_check: capOk(60),
      success_metric: L('الحجوزات المكتملة خلال فترة المناسبة', 'Completed bookings during the event'), experiment_design: L('قارني بالفترة نفسها سابقاً إن وُجدت', 'Compare with the same period before, if available'),
      limitations: L('التاريخ من تقويمك الموثّق.', 'The date comes from your verified calendar.'),
    }));
  }

  // 9) Content — service descriptions/photos consistent with brand resources.
  for (const s of d.services.filter((x) => x.demand.views >= 5 && (!x.has_image || !x.has_description)).slice(0, 2)) {
    out.push(base(ctx, {
      title: L(`تحسين عرض ${s.name}`, `Improve how ${s.name} is presented`), category: 'content', fingerprint: `content:${s.id}`, service_ids: [s.id],
      evidence_refs: [`service.${s.ref}.views_30d`, `service.${s.ref}.booking_starts_30d`],
      opportunity: L(`${s.demand.views} مشاهدة دون ${!s.has_image ? 'صورة' : 'وصف'} للخدمة.`, `${s.demand.views} views without a service ${!s.has_image ? 'photo' : 'description'}.`),
      suggested_action: L('أضيفي صورة حقيقية ووصفاً واضحاً بنبرة علامتك.', 'Add a real photo and a clear description in your brand tone.'),
      prerequisites: d.preferences.photography_resources ? [] : [L('مصدر صور (تصوير ذاتي أو مصورة)', 'A photography resource (self-shot or photographer)')],
      success_metric: L('نسبة بدء الحجز من المشاهدات', 'Booking starts per view'), experiment_design: L('قبل/بعد لمدة أسبوعين', 'Two-week before/after'),
      limitations: '',
    }));
  }

  // 10) Campaign results review.
  const lastCampaign = d.campaigns.find((c) => c.targeted > 0);
  if (lastCampaign) {
    out.push(base(ctx, {
      title: L('مراجعة نتائج آخر حملة', 'Review the last campaign'), category: 'campaign_review', fingerprint: `campaign_review:${lastCampaign.ref}:${lastCampaign.targeted}`,
      evidence_refs: [`campaign.${lastCampaign.ref}.targeted`, `campaign.${lastCampaign.ref}.conversions`],
      opportunity: L(`${lastCampaign.conversions} حجوزات مكتملة منسوبة من ${lastCampaign.targeted} رسالة.`, `${lastCampaign.conversions} attributed completed bookings from ${lastCampaign.targeted} messages.`),
      suggested_action: L('قارني المجموعة المستهدفة بالمجموعة الضابطة قبل تكرار الحملة.', 'Compare the targeted group with the holdout before repeating the campaign.'),
      success_metric: L('الإيراد الإضافي مقابل الضابطة', 'Incremental revenue vs holdout'), experiment_design: L('مجموعة ضابطة', 'Holdout group'),
      limitations: L('الإسناد ليس دليلاً سببياً.', 'Attribution is not causal proof.'),
    }));
  }
  return out;
}

const monthName = (from: string, locale: 'ar' | 'en') => new Intl.DateTimeFormat(locale === 'ar' ? 'ar-SA-u-ca-gregory-nu-latn' : 'en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${from}T00:00:00Z`));

function limitationsText(d: SnapshotData, extra: string[]) {
  const loc = d.business.locale;
  return [...d.sufficiency.missing.map((m) => missingText(loc, m)), ...extra].join(' • ');
}

export function rulesMonthlyPlan(d: SnapshotData, recs: RecDraft[], from: string, to: string, extraLimitations: string[] = []): { title: string; content: PlanContent } {
  const L = (ar: string, en: string) => (d.business.locale === 'ar' ? ar : en);
  const top = recs.filter((r) => r.category !== 'pricing' || r.fingerprint !== 'pricing:costs_missing').slice(0, 4);
  const initiatives = top.map((r, i) => ({ id: `i${i + 1}`, title: r.title, description: r.suggested_action, evidence_refs: r.evidence_refs }));
  const activities = top.map((r, i) => {
    const start = addDays(from, i * 7);
    return {
      id: `a${i + 1}`, title: r.title, initiative_id: `i${i + 1}`, date_from: start <= to ? start : from, date_to: addDays(start, 6) <= to ? addDays(start, 6) : to,
      channel: r.channel, content_idea: r.draft_content?.text ?? null, owner: L('المالكة', 'Owner'), capacity_note: r.capacity_check.status === 'ok' || r.capacity_check.status === 'not_applicable' ? null : r.capacity_check.status,
      monthly_goal_ref: null, status: 'planned' as const,
    };
  });
  const occ = d.metrics['capacity.past28.occupancy']?.value ?? null;
  const conv = d.metrics['storefront.conversion_rate_30d']?.value ?? null;
  const completed = d.metrics['bookings.completed_90d']?.value ?? null;
  const budget = d.preferences.monthly_budget_minor;
  return {
    title: L(`خطة ${monthName(from, 'ar')}`, `${monthName(from, 'en')} plan`),
    content: {
      goal: d.preferences.goals[0] ?? L('ملء الفترات الهادئة واستعادة العميلات في موعدهن دون خصومات دائمة', 'Fill quiet periods and bring customers back on time without perpetual discounts'),
      baseline: [
        { metric_key: 'bookings.completed_90d', label: d.metrics['bookings.completed_90d']?.label ?? '', value: completed },
        { metric_key: 'capacity.past28.occupancy', label: d.metrics['capacity.past28.occupancy']?.label ?? '', value: occ },
        { metric_key: 'storefront.conversion_rate_30d', label: d.metrics['storefront.conversion_rate_30d']?.label ?? '', value: conv },
        { metric_key: 'customers.inactive_90d', label: d.metrics['customers.inactive_90d']?.label ?? '', value: d.metrics['customers.inactive_90d']?.value ?? null },
      ],
      initiatives, activities,
      dates: { start: from, end: to },
      owner: L('المالكة', 'Owner'),
      budget: budget === null
        ? { amount_minor: null, status: 'no_budget_set', assumptions: L('لم تُحدَّد ميزانية؛ الأنشطة تستخدم قنواتك الحالية.', 'No budget set; activities use your existing channels.') }
        : { amount_minor: budget, status: 'unknown', assumptions: L('تكلفة كل نشاط غير مقدّرة؛ التزمي بالميزانية المحددة.', 'Per-activity costs are not estimated; stay within the set budget.') },
      metrics: [
        { key: 'capacity.past28.occupancy', label: L('الإشغال', 'Occupancy'), baseline: occ, proposed_target: occ === null ? null : Math.min(0.9, Math.round((occ + 0.05) * 100) / 100) },
        { key: 'storefront.conversion_rate_30d', label: L('معدل التحويل', 'Conversion rate'), baseline: conv, proposed_target: null },
      ],
      monthly_goals: initiatives.map((i) => ({ id: i.id, title: i.title })),
      experimental: d.sufficiency.level !== 'ok',
      limitations: limitationsText(d, [L('الأهداف مقترحة وليست توقعات.', 'Targets are proposals, not forecasts.'), ...extraLimitations]),
    },
  };
}

export function rulesWeeklyPlan(d: SnapshotData, parent: PlanContent | null, from: string, to: string, extraLimitations: string[] = []): { title: string; content: PlanContent } {
  const L = (ar: string, en: string) => (d.business.locale === 'ar' ? ar : en);
  const wd = WEEKDAYS[d.business.locale];
  const days = d.capacity.next_days.filter((x) => x.date >= from && x.date <= to);
  const free = days.filter((x) => x.free_min >= 60).sort((a, b) => b.free_min - a.free_min);
  const goals = (parent?.initiatives ?? []).slice(0, 3);
  const activities = goals.map((g, i) => {
    const day = free[i % Math.max(1, free.length)];
    return {
      id: `w${i + 1}`, title: g.title, initiative_id: null, date_from: day?.date ?? null, date_to: day?.date ?? null,
      channel: parent?.activities.find((a) => a.initiative_id === g.id)?.channel ?? null,
      content_idea: parent?.activities.find((a) => a.initiative_id === g.id)?.content_idea ?? null, owner: L('المالكة', 'Owner'),
      capacity_note: day ? L(`${wd[day.weekday]}: ${day.free_min} دقيقة متاحة`, `${wd[day.weekday]}: ${day.free_min} free minutes`) : L('لا يوجد وقت متاح كافٍ هذا الأسبوع', 'Not enough free time this week'),
      monthly_goal_ref: g.id, status: 'planned' as const,
    };
  });
  const occ = d.metrics['capacity.next14.occupancy']?.value ?? null;
  return {
    title: L(`خطة أسبوع ${from}`, `Week of ${from}`),
    content: {
      goal: parent ? L(`دعم أهداف الشهر: ${parent.goal}`, `Support the monthly goal: ${parent.goal}`) : L('استغلال الوقت المتاح هذا الأسبوع', 'Use this week’s free time'),
      baseline: [{ metric_key: 'capacity.next14.occupancy', label: d.metrics['capacity.next14.occupancy']?.label ?? '', value: occ }],
      initiatives: [], activities, dates: { start: from, end: to }, owner: L('المالكة', 'Owner'),
      budget: { amount_minor: null, status: d.preferences.monthly_budget_minor === null ? 'no_budget_set' : 'unknown', assumptions: L('ضمن ميزانية الشهر.', 'Within the monthly budget.') },
      metrics: [{ key: 'capacity.next14.occupancy', label: L('الإشغال القادم', 'Upcoming occupancy'), baseline: occ, proposed_target: null }],
      monthly_goals: goals.map((g) => ({ id: g.id, title: g.title })),
      experimental: d.sufficiency.level !== 'ok',
      limitations: limitationsText(d, [L('الأنشطة موزعة على الأيام ذات الوقت المتاح فقط.', 'Activities are placed only on days with free time.'), ...extraLimitations]),
    },
  };
}

/** A clearly labelled EXAMPLE (not analysis of this business). */
export function examplePlan(locale: 'ar' | 'en', kind: 'monthly' | 'weekly', from: string, to: string): { title: string; content: PlanContent } {
  const L = (ar: string, en: string) => (locale === 'ar' ? ar : en);
  return {
    title: L('مثال توضيحي — ليس تحليلاً لنشاطك', 'Example — not an analysis of your business'),
    content: {
      goal: L('مثال: زيادة حجوزات أيام الأسبوع الهادئة', 'Example: more bookings on quiet weekdays'),
      baseline: [],
      initiatives: [{ id: 'i1', title: L('مثال: تذكير العميلات بموعد العودة', 'Example: return-time reminders'), description: L('هذا مثال لشكل الخطة فقط.', 'This only illustrates the plan format.'), evidence_refs: [] }],
      activities: [{ id: 'a1', title: L('مثال: رسالة تذكير', 'Example: reminder message'), initiative_id: 'i1', date_from: from, date_to: kind === 'weekly' ? to : addDays(from, 6), channel: 'in_app', content_idea: L('مثال نصّي', 'Sample copy'), owner: L('المالكة', 'Owner'), capacity_note: null, monthly_goal_ref: null, status: 'planned' }],
      dates: { start: from, end: to }, owner: L('المالكة', 'Owner'),
      budget: { amount_minor: null, status: 'no_budget_set', assumptions: L('مثال', 'Example') },
      metrics: [], monthly_goals: [], experimental: true,
      limitations: L('هذا مثال توضيحي ولا يستند إلى بيانات نشاطك.', 'This is an illustrative example and is not based on your data.'),
    },
  };
}

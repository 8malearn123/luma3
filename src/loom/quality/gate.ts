import type { MetricContext } from '../metrics/context';
import type { QualityDomain } from '../metrics/registry';
import { L, type Localized } from '../util/text';
import { convertQty } from '../util/units';

/**
 * Data-quality gate (§5.4). Runs before every analysis; each domain gets a
 * level and the concrete actions that would improve it (Arabic + English).
 * Detectors declare the minimum level they need per domain.
 */
export type QualityLevel = 'ok' | 'limited' | 'insufficient';
export const QUALITY_DOMAINS: QualityDomain[] = ['sales', 'customers', 'capacity', 'economics', 'inventory', 'demand', 'reviews', 'campaigns'];
export type QualityCheck = {
  id: 'freshness' | 'cost_completeness' | 'consistency' | 'sample_size' | 'duplicates' | 'units' | 'regime_change' | 'history' | 'schedule' | 'recipes';
  domain: QualityDomain; level: QualityLevel; value: number | null; detail: Localized; improve: Localized | null;
};
export type DomainQuality = { level: QualityLevel; reasons: Localized[]; improve: Localized[] };
export type QualityReport = {
  overall: QualityLevel;
  domains: Record<QualityDomain, DomainQuality>;
  checks: QualityCheck[];
  regime_change: boolean;
  /** New or thin business (< 30 days or < 20 completed sales): exploratory analysis only (T11). */
  exploratory: boolean;
  data_needed: Localized[];
  excluded_inconsistent: number;
};

const rank: Record<QualityLevel, number> = { ok: 0, limited: 1, insufficient: 2 };
export const worse = (a: QualityLevel, b: QualityLevel): QualityLevel => (rank[a] >= rank[b] ? a : b);
export const meets = (have: QualityLevel, need: 'ok' | 'limited') => rank[have] <= rank[need];

/** Freshness limits per entity (ms): transactions 1 hour, costs 30 days, everything else 1 day. */
const FRESHNESS: Record<string, number> = { transactions: 3_600_000, cost_facts: 30 * 86_400_000 };

export function qualityGate(ctx: MetricContext): QualityReport {
  const { ds } = ctx;
  const checks: QualityCheck[] = [];
  const add = (c: QualityCheck) => checks.push(c);

  // Freshness (sync instant per entity vs. the entity limit).
  for (const [entity, at] of Object.entries(ds.meta.synced_at)) {
    const limit = FRESHNESS[entity] ?? 86_400_000;
    if (ds.meta.as_of - at > limit) {
      const domain: QualityDomain = entity === 'cost_facts' ? 'economics' : entity === 'capacity_windows' ? 'capacity' : entity === 'customers' ? 'customers' : 'sales';
      add({ id: 'freshness', domain, level: 'limited', value: Math.round((ds.meta.as_of - at) / 60_000),
        detail: L(`بيانات ${entity} قديمة`, `${entity} data is stale`), improve: L('أعيدي المزامنة', 'Run the sync again') });
    }
  }

  // Sample size / history.
  const sales = ctx.sales90.length;
  const ageDays = (ds.meta.as_of - ds.business.created_at) / 86_400_000;
  add({ id: 'sample_size', domain: 'sales', level: sales >= 20 ? 'ok' : sales > 0 ? 'limited' : 'insufficient', value: sales,
    detail: L(`${sales} عملية بيع مكتملة خلال ٩٠ يومًا`, `${sales} completed sales in 90 days`),
    improve: sales >= 20 ? null : L('سجّلي الحجوزات والمبيعات المكتملة في لوما (٢٠ على الأقل) لتفعيل التحليل الكامل', 'Record completed bookings and sales in LUMA (at least 20) to enable the full analysis') });
  if (ageDays < 30) add({ id: 'history', domain: 'sales', level: 'limited', value: Math.floor(ageDays),
    detail: L(`عمر النشاط في لوما ${Math.floor(ageDays)} يومًا`, `The business has been on LUMA for ${Math.floor(ageDays)} days`),
    improve: L('التحليل استكشافي حتى يتجاوز عمر البيانات ٣٠ يومًا', 'The analysis stays exploratory until there are 30 days of data') });

  // Consistency.
  const bad = ctx.inconsistent90.length;
  if (bad) add({ id: 'consistency', domain: 'sales', level: bad / Math.max(1, ctx.tx90.length) > 0.05 ? 'limited' : 'ok', value: bad,
    detail: L(`${bad} معاملة متناقضة استُبعدت من الحساب`, `${bad} inconsistent transactions were excluded`), improve: L('راجعي المعاملات التي لا تطابق بنودها إجماليها', 'Review transactions whose lines do not match their total') });

  // Regime change: last week's completed sales vs. the previous 7 weeks (> 3σ).
  const weeks = Array.from({ length: 8 }, (_, i) => ctx.sales90.filter((t) => t.occurred_at >= ctx.todayStart - (i + 1) * 7 * 86_400_000 && t.occurred_at < ctx.todayStart - i * 7 * 86_400_000).length);
  const prev = weeks.slice(1);
  const mean = prev.reduce((a, b) => a + b, 0) / prev.length;
  const sd = Math.sqrt(prev.reduce((a, b) => a + (b - mean) ** 2, 0) / prev.length);
  const regime = sd > 0 && Math.abs(weeks[0]! - mean) > 3 * sd && sales >= 20;
  if (regime) add({ id: 'regime_change', domain: 'sales', level: 'limited', value: weeks[0]!,
    detail: L('تغير جوهري في حجم المبيعات الأسبوع الماضي؛ لا تُقارن الفترة بخط أساس قديم', 'A material change in weekly sales; the period is not compared with an old baseline'), improve: null });

  // Costs.
  const cc = ctx.businessCostCompleteness;
  const thr = ctx.settings.cost_completeness_threshold;
  const missing = cc.missing.length;
  add({ id: 'cost_completeness', domain: 'economics', level: cc.value === null ? (missing ? 'insufficient' : 'limited') : cc.value >= thr ? (missing ? 'limited' : 'ok') : cc.value > 0 ? 'limited' : 'insufficient',
    value: cc.value, detail: L(`اكتمال التكاليف ${cc.value === null ? '—' : Math.round(cc.value * 100) + '%'} (الحد ${Math.round(thr * 100)}%)`, `Cost completeness ${cc.value === null ? '—' : Math.round(cc.value * 100) + '%'} (threshold ${Math.round(thr * 100)}%)`),
    improve: missing ? L(`سجّلي تكلفة ${missing} خدمات أو منتجات لتفعيل فحص الهامش`, `Record the cost of ${missing} services or products to enable the margin check`) : null });

  // Units: recipe units must convert to the item unit.
  const itemBy = new Map(ds.inventory.map((i) => [i.id, i]));
  const mismatched = ds.requirements.filter((r) => r.type === 'material' && (!itemBy.get(r.ref_id ?? '') || convertQty(1, r.unit, itemBy.get(r.ref_id!)!.unit) === null));
  const recipes = new Set(ds.requirements.filter((r) => r.type === 'material').map((r) => r.offering_id));
  const svcNoRecipe = ctx.activeServices.filter((s) => !recipes.has(s.id)).length;
  add({ id: 'units', domain: 'inventory', level: mismatched.length ? 'limited' : 'ok', value: mismatched.length,
    detail: L(`${mismatched.length} بند وصفة بوحدة لا تتطابق مع وحدة المخزون`, `${mismatched.length} recipe lines use a unit that does not match the stock unit`),
    improve: mismatched.length ? L('صحّحي وحدات وصفات الاستهلاك', 'Fix the units of the consumption recipes') : null });
  add({ id: 'recipes', domain: 'inventory', level: svcNoRecipe === 0 ? 'ok' : recipes.size ? 'limited' : 'insufficient', value: svcNoRecipe,
    detail: L(`${svcNoRecipe} خدمة بلا وصفة استهلاك`, `${svcNoRecipe} services have no consumption recipe`),
    improve: svcNoRecipe ? L(`أضيفي وصفة استهلاك لـ ${svcNoRecipe} خدمات لتفعيل فحص المخزون`, `Add a consumption recipe for ${svcNoRecipe} services to enable the inventory check`) : null });

  // Capacity: a schedule for the next 14 days.
  const avail = ctx.nextDays.reduce((m, d) => m + d.available_min, 0);
  add({ id: 'schedule', domain: 'capacity', level: avail > 0 ? 'ok' : 'insufficient', value: avail,
    detail: L(`${avail} دقيقة عمل مجدولة في الأيام الـ ١٤ القادمة`, `${avail} scheduled working minutes in the next 14 days`),
    improve: avail > 0 ? null : L('أضيفي ساعات عمل الفريق لتفعيل فحص الطاقة', 'Add team working hours to enable the capacity check') });

  // Customers: duplicates and sample.
  const keys = new Map<string, number>();
  for (const c of ds.customers) if (c.dup_key) keys.set(c.dup_key, (keys.get(c.dup_key) ?? 0) + 1);
  const dups = [...keys.values()].filter((n) => n > 1).reduce((m, n) => m + n - 1, 0);
  const withVisits = ds.customers.filter((c) => c.visits > 0).length;
  add({ id: 'sample_size', domain: 'customers', level: withVisits >= 20 ? 'ok' : withVisits > 0 ? 'limited' : 'insufficient', value: withVisits,
    detail: L(`${withVisits} عميلة لها زيارة مكتملة`, `${withVisits} customers with a completed visit`), improve: withVisits >= 20 ? null : L('اربطي الحجوزات بملفات العميلات', 'Link bookings to customer records') });
  if (dups) add({ id: 'duplicates', domain: 'customers', level: dups / Math.max(1, ds.customers.length) > 0.05 ? 'limited' : 'ok', value: dups,
    detail: L(`نحو ${dups} سجل عميلة مكرر محتمل`, `About ${dups} possible duplicate customer records`), improve: L('ادمجي سجلات العميلات المكررة', 'Merge duplicate customer records') });

  // Demand, reviews, campaigns.
  const sessions = ctx.sessions30();
  add({ id: 'sample_size', domain: 'demand', level: sessions >= 30 ? 'ok' : sessions > 0 ? 'limited' : 'insufficient', value: sessions,
    detail: L(`${sessions} زيارة للمتجر خلال ٣٠ يومًا`, `${sessions} storefront sessions in 30 days`), improve: sessions >= 30 ? null : L('انشري المتجر وشاركي رابطه لقياس الطلب والتحويل', 'Publish and share the storefront to measure demand and conversion') });
  const reviews = ds.reviews.filter((r) => r.verified).length;
  add({ id: 'sample_size', domain: 'reviews', level: reviews >= 10 ? 'ok' : reviews > 0 ? 'limited' : 'insufficient', value: reviews,
    detail: L(`${reviews} تقييم موثّق`, `${reviews} verified reviews`), improve: reviews >= 10 ? null : L('فعّلي طلبات التقييم بعد الزيارة', 'Turn on review requests after visits') });
  const camps = ds.campaigns.filter((c) => c.targeted > 0).length;
  add({ id: 'sample_size', domain: 'campaigns', level: camps ? 'limited' : 'insufficient', value: camps,
    detail: L(`${camps} حملة بنتائج`, `${camps} campaigns with results`), improve: camps ? null : L('نفّذي حملة صغيرة بمجموعة ضابطة لقياس الأثر', 'Run a small campaign with a holdout group to measure impact') });

  const domains = Object.fromEntries(QUALITY_DOMAINS.map((d) => {
    const cs = checks.filter((c) => c.domain === d);
    const level = cs.reduce<QualityLevel>((m, c) => worse(m, c.level), cs.length ? 'ok' : 'insufficient');
    return [d, { level, reasons: cs.filter((c) => c.level !== 'ok').map((c) => c.detail), improve: cs.map((c) => c.improve).filter((x): x is Localized => !!x) }];
  })) as Record<QualityDomain, DomainQuality>;
  const exploratory = ageDays < 30 || sales < 20;
  const core = [domains.sales.level, domains.capacity.level];
  const overall: QualityLevel = (!ctx.activeServices.length && !ctx.activeOfferings.length) || core.every((l) => l === 'insufficient') ? 'insufficient'
    : core.some((l) => l !== 'ok') || domains.economics.level !== 'ok' ? 'limited' : 'ok';
  const data_needed = exploratory ? [...domains.sales.improve, ...domains.capacity.improve, ...domains.economics.improve, ...domains.customers.improve].slice(0, 6) : [];
  return { overall, domains, checks, regime_change: regime, exploratory, data_needed, excluded_inconsistent: bad };
}

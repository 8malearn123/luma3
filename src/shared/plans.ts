/**
 * Plan feature keys. Plans (Sanaa / Wahaj / Fareed) are data in the `plans` and
 * `plan_features` tables and editable by the LUMA owner; these keys are the
 * contract the server enforces. Limits are NOT approved final values.
 */
export const PLAN_FEATURES = {
  // Countable limits (limit_value NULL = unlimited)
  'limit.branches': { kind: 'limit', label_ar: 'عدد الفروع', label_en: 'Branches' },
  'limit.staff': { kind: 'limit', label_ar: 'عدد الموظفات', label_en: 'Team members' },
  'limit.services': { kind: 'limit', label_ar: 'عدد الخدمات', label_en: 'Services' },
  'limit.products': { kind: 'limit', label_ar: 'عدد المنتجات', label_en: 'Products' },
  'limit.custom_pages': { kind: 'limit', label_ar: 'الصفحات الإضافية', label_en: 'Custom pages' },
  'limit.ai_runs_monthly': { kind: 'limit', label_ar: 'تحليلات الذكاء الاصطناعي شهرياً', label_en: 'AI analyses per month' },
  // Multi-location inventory & purchasing (0801_inventory_plan_features.sql; distribution «مقترح — غير معتمد»).
  'limit.stock_locations': { kind: 'limit', label_ar: 'مواقع المخزون الإضافية', label_en: 'Additional stock locations' },
  // Feature switches
  'feature.products': { kind: 'switch', label_ar: 'المتجر والمنتجات', label_en: 'Products & shop' },
  'feature.inventory': { kind: 'switch', label_ar: 'المخزون التشغيلي', label_en: 'Operational inventory' },
  'feature.marketing_ai': { kind: 'switch', label_ar: 'لووم للتسويق', label_en: 'Loom Marketing' },
  'feature.customization_ai': { kind: 'switch', label_ar: 'مساعد التخصيص', label_en: 'Customization assistant' },
  'feature.campaigns': { kind: 'switch', label_ar: 'الحملات', label_en: 'Campaigns' },
  'feature.loyalty': { kind: 'switch', label_ar: 'الولاء', label_en: 'Loyalty' },
  'feature.gift_cards': { kind: 'switch', label_ar: 'بطاقات الهدايا', label_en: 'Gift cards' },
  'feature.memberships': { kind: 'switch', label_ar: 'العضويات والباقات المسبقة', label_en: 'Memberships & prepaid' },
  'feature.waitlist': { kind: 'switch', label_ar: 'قائمة الانتظار', label_en: 'Waitlist' },
  'feature.group_sessions': { kind: 'switch', label_ar: 'الجلسات الجماعية', label_en: 'Group sessions' },
  'feature.resources': { kind: 'switch', label_ar: 'الموارد (غرف/كراسي)', label_en: 'Resources (rooms/chairs)' },
  'feature.finance_reports': { kind: 'switch', label_ar: 'التقارير المالية', label_en: 'Finance reports' },
  'feature.remove_powered_by': { kind: 'switch', label_ar: 'إخفاء "بدعم من لوما"', label_en: 'Hide "Powered by LUMA"' },
  'feature.inventory_transfers': { kind: 'switch', label_ar: 'المناقلات بين المواقع', label_en: 'Stock transfers' },
  'feature.inventory_counts': { kind: 'switch', label_ar: 'الجرد الفعلي', label_en: 'Physical stock counts' },
  'feature.purchasing': { kind: 'switch', label_ar: 'المشتريات والموردون', label_en: 'Purchasing & suppliers' },
  'feature.inventory_finance_link': { kind: 'switch', label_ar: 'ربط المخزون بالمحاسبة', label_en: 'Inventory accounting link' },
  'feature.inventory_reports_advanced': { kind: 'switch', label_ar: 'تقارير المخزون المتقدمة', label_en: 'Advanced inventory reports' },
} as const;

export type PlanFeatureKey = keyof typeof PLAN_FEATURES;
export type PlanLimitKey = Extract<PlanFeatureKey, `limit.${string}`>;

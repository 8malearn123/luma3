import { L } from '../util/text';
import type { InterventionDef, InterventionId, SectorPack } from './types';

const I = (id: InterventionId, kind: InterventionDef['kind'], effort: number, cash: InterventionDef['cash_cost'], channels: InterventionDef['channels'], ar: string, en: string, discount = false): InterventionDef =>
  ({ id, kind, effort_hours: effort, cash_cost: cash, channels, description: L(ar, en), discount });

const catalog: Record<InterventionId, InterventionDef> = {
  targeted_reminder: I('targeted_reminder', 'reminder', 1, 'none', ['in_app', 'whatsapp', 'sms'], 'رسالة للعميلات الموافقات على التسويق تعرض أوقاتًا هادئة محددة برابط حجز مباشر، دون خصم.', 'A message to consenting customers offering specific quiet times with a direct booking link, without a discount.'),
  off_peak_package: I('off_peak_package', 'package', 2, 'none', ['storefront', 'in_app'], 'باقة خاصة بالأوقات الهادئة تجمع خدمتين بهامش موجب، بالسعر الكامل أو بميزة غير نقدية.', 'An off-peak package of two services with a positive margin, at full price or with a non-cash perk.'),
  value_add: I('value_add', 'value_add', 1, 'variable', ['in_app', 'storefront'], 'قيمة مضافة صغيرة (إضافة خدمة قصيرة أو منتج تجريبي) بدل الخصم.', 'A small added value (a short add-on or a sample product) instead of a discount.'),
  content_feature: I('content_feature', 'content', 2, 'none', ['storefront', 'instagram'], 'إبراز الخدمة في أعلى المتجر بصور حقيقية وآراء العميلات.', 'Feature the service at the top of the storefront with real photos and reviews.'),
  limited_discount: I('limited_discount', 'limited_discount', 1, 'variable', ['in_app', 'whatsapp', 'sms'], 'تجربة خصم محدودة على مجموعة صغيرة مع مجموعة ضابطة، ضمن سقف الخصم وبعد اجتياز التعادل.', 'A limited discount trial on a small group with a holdout, within the discount cap and only after passing break-even.', true),
  reminder_due: I('reminder_due', 'reminder', 1, 'none', ['in_app', 'whatsapp', 'sms'], 'تذكير ودّي بموعد العودة المعتاد لهذه الخدمة، للموافقات على التسويق فقط.', 'A friendly reminder of the usual return time for this service, to consenting customers only.'),
  loyalty_reward: I('loyalty_reward', 'loyalty', 2, 'variable', ['in_app'], 'مكافأة ولاء للزيارة التالية بدل الخصم العام.', 'A loyalty reward for the next visit instead of a general discount.'),
  open_slots: I('open_slots', 'open_slots', 2, 'none', ['in_store'], 'فتح مواعيد إضافية (ورديات أو إعادة توزيع) للخدمة المطلوبة قبل أي ترويج.', 'Open more appointments (shifts or reallocation) for the requested service before any promotion.'),
  waitlist_flow: I('waitlist_flow', 'booking_ux', 1, 'none', ['storefront'], 'تفعيل قائمة الانتظار وعرضها عند عدم توفر موعد.', 'Turn on the waitlist and show it when no time is available.'),
  staff_cross_training: I('staff_cross_training', 'staffing', 8, 'variable', ['in_store'], 'تأهيل أخصائية إضافية لهذه الخدمة.', 'Qualify an additional specialist for this service.'),
  price_review: I('price_review', 'price_review', 2, 'none', ['in_store'], 'مراجعة السعر (رفع مدروس بتجربة محدودة) عبر مقترح سعر يحتاج اعتمادك؛ لا تغيير تلقائي.', 'Review the price (a measured increase in a limited trial) through a price proposal that needs your approval; nothing changes automatically.'),
  improve_description: I('improve_description', 'content', 1, 'none', ['storefront'], 'وصف أوضح للخدمة: المدة والنتيجة والسعر وما يشمله.', 'A clearer description: duration, result, price and what is included.'),
  simplify_booking: I('simplify_booking', 'booking_ux', 2, 'none', ['storefront'], 'تبسيط خطوات الحجز وشروط الدفع والعربون.', 'Simplify the booking steps and the payment/deposit terms.'),
  add_images: I('add_images', 'content', 2, 'none', ['storefront'], 'إضافة صور حقيقية للخدمة.', 'Add real photos of the service.'),
  faq: I('faq', 'content', 1, 'none', ['storefront'], 'إضافة أسئلة شائعة تجيب عن سبب التردد.', 'Add FAQs that answer why visitors hesitate.'),
  bundle_with_top_service: I('bundle_with_top_service', 'package', 2, 'none', ['storefront', 'in_store'], 'باقة تجمع المنتج مع خدمة رائجة بهامش موجب.', 'Bundle the product with a popular service that has a positive margin.'),
  gift_with_service: I('gift_with_service', 'value_add', 1, 'variable', ['in_store'], 'تقديم المنتج هدية مع الخدمة الرائجة (بتكلفته فقط).', 'Give the product as a gift with the popular service (at its cost only).'),
  bundle_with_service: I('bundle_with_service', 'package', 2, 'none', ['in_store', 'storefront'], 'عرض المنتج مع الخدمة التي يشتريه عملاؤها أكثر من غيرهم.', 'Offer the product with the service whose customers buy it more than others.'),
  in_store_recommendation: I('in_store_recommendation', 'content', 1, 'none', ['in_store'], 'توصية الأخصائية بالمنتج بعد الخدمة.', 'The specialist recommends the product after the service.'),
  cost_review: I('cost_review', 'price_review', 2, 'none', ['in_store'], 'مراجعة مكونات التكلفة (المواد والعمولة) قبل أي ترويج.', 'Review the cost components (materials, commission) before any promotion.'),
  record_costs: I('record_costs', 'price_review', 1, 'none', ['in_store'], 'تسجيل تكلفة المواد لكل خدمة أو وصفة استهلاك من صفحة الخدمات.', 'Record each service’s material cost or a consumption recipe on the Services page.'),
  loyalty_program: I('loyalty_program', 'loyalty', 3, 'variable', ['in_app'], 'برنامج نقاط بسيط يكافئ الزيارة التالية بدل الخصومات المتكررة.', 'A simple points program rewarding the next visit instead of repeated discounts.'),
  add_shift: I('add_shift', 'staffing', 3, 'variable', ['in_store'], 'إضافة وردية أو أخصائية مؤهلة في النافذة المطلوبة قبل الحملة.', 'Add a shift or a qualified specialist in the window before the campaign.'),
  restock: I('restock', 'restock', 1, 'variable', ['in_store'], 'إعادة طلب المواد اللازمة قبل الحملة.', 'Reorder the required materials before the campaign.'),
  review_results: I('review_results', 'content', 1, 'none', ['in_app'], 'مراجعة نتيجة الحملة مقابل المجموعة الضابطة قبل تكرارها.', 'Review the campaign against its holdout before repeating it.'),
};

/** Beauty (salons and independent experts): capacity = qualified specialists' minutes + rooms. */
export const beautyPack: SectorPack = {
  id: 'beauty',
  version: 'beauty-1.0.0',
  vocabulary: { resource: L('أخصائية', 'Specialist'), offering: L('خدمة', 'Service'), customer: L('عميلة', 'Customer') },
  capacityModel: { resources: ['staff', 'room', 'equipment'], unit: 'minutes', quiet_below: 0.4, full_above: 0.9 },
  detectors: [
    { id: 'quiet_capacity', params: { min_available_min: 180, quiet_below: 0.4, max_slots: 3, uplift_pp: 0.05 } },
    { id: 'high_satisfaction_low_demand', params: { min_rating: 4.5, min_reviews: 5 } },
    { id: 'lapsed_cohort', params: { min_lapsed: 3, response_share: 0.2 } },
    { id: 'unserved_demand', params: { min_signals: 5, full_above: 0.9 } },
    { id: 'conversion_friction', params: { min_starts: 20, max_start_to_confirm: 0.3 } },
    { id: 'cross_sell_affinity', params: { min_lift: 1.5, min_co_buyers: 3 } },
    { id: 'slow_mover_bundle', params: { cover_days: 180 } },
    { id: 'margin_leak', params: { thin_below: 0.2 } },
    { id: 'missing_cost_blocker', params: {} },
    { id: 'offering_presentation', params: { min_views: 5 } },
    { id: 'loyalty_over_discount', params: { min_discount_share: 0.3, max_repeat: 0.3, min_customers: 20 } },
    { id: 'campaign_learning', params: { min_group: 30 } },
  ],
  interventions: {
    quiet_capacity: ['targeted_reminder', 'off_peak_package', 'value_add', 'content_feature', 'limited_discount'],
    high_satisfaction_low_demand: ['content_feature', 'targeted_reminder', 'value_add', 'limited_discount'],
    lapsed_cohort: ['reminder_due', 'loyalty_reward', 'value_add', 'limited_discount'],
    unserved_demand: ['open_slots', 'waitlist_flow', 'staff_cross_training', 'price_review'],
    conversion_friction: ['improve_description', 'simplify_booking', 'add_images', 'faq'],
    cross_sell_affinity: ['bundle_with_service', 'in_store_recommendation'],
    slow_mover_bundle: ['bundle_with_top_service', 'gift_with_service'],
    margin_leak: ['cost_review', 'price_review'],
    missing_cost_blocker: ['record_costs'],
    offering_presentation: ['add_images', 'improve_description'],
    loyalty_over_discount: ['loyalty_program'],
    capacity_prerequisite: ['add_shift', 'restock'],
    campaign_learning: ['review_results'],
  },
  catalog,
  validation: {
    forbiddenClaims: [/يعالج|علاج|يشفي|مضمون ?100|guaranteed|cures?|treats?|medical/i],
    awarenessOnlyTopics: ['breast_cancer_awareness', 'world_health_day', 'diabetes_day'],
  },
  default_discount_bp: 1500,
};

const PACKS: Record<string, SectorPack> = { beauty: beautyPack };
export function sectorPack(id: string): SectorPack { return PACKS[id] ?? beautyPack; }
export const registeredSectorPacks = () => Object.keys(PACKS);

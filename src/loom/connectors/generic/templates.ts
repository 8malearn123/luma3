import { L, type Localized } from '../../util/text';

/**
 * Documented import templates, one per canonical entity (§5.1). A source
 * file (CSV upload, REST page, webhook event) is a list of rows; the
 * connection's column mapping renames source columns to these fields.
 * Transactions come in two files: `transactions` and `transaction_lines`.
 *
 * Privacy: Loom is pseudonymous. Customer rows carry an opaque id from the
 * source (never a name, phone or e-mail); columns that look like contact
 * details are refused (PII_COLUMN).
 */
export const SOURCE_ENTITIES = ['offerings', 'offering_requirements', 'inventory_items', 'resources', 'capacity_windows', 'transactions',
  'transaction_lines', 'cost_facts', 'demand_signals', 'reviews', 'customers'] as const;
export type SourceEntity = (typeof SOURCE_ENTITIES)[number];

export type FieldType = 'string' | 'money' | 'number' | 'int' | 'bool' | 'datetime' | 'date' | 'enum' | 'list';
export type FieldDef = { field: string; type: FieldType; required?: boolean; values?: readonly string[]; default?: string; doc: Localized };
export type Template = { entity: SourceEntity; key: string[]; fields: FieldDef[]; doc: Localized; example: Record<string, string> };

const f = (field: string, type: FieldType, doc: Localized, extra: Partial<FieldDef> = {}): FieldDef => ({ field, type, doc, ...extra });
const req = { required: true };

export const PII_COLUMN = /(^|_)(name|first_name|last_name|full_name|phone|mobile|email|e_mail|address|national_id|iqama|passport)($|_)/i;

export const TEMPLATES: Record<SourceEntity, Template> = {
  offerings: {
    entity: 'offerings', key: ['id'], doc: L('ما يُعرض على العميل: خدمة أو منتج أو باقة.', 'What is offered: a service, product or package.'),
    fields: [
      f('id', 'string', L('معرّف ثابت في نظامك', 'Stable id in your system'), req),
      f('kind', 'enum', L('النوع', 'Kind'), { ...req, values: ['service', 'product', 'package', 'membership', 'gift'] }),
      f('name', 'string', L('الاسم بالعربية (أو الوحيد)', 'Name (Arabic or only name)'), req),
      f('name_en', 'string', L('الاسم بالإنجليزية', 'English name')),
      f('price', 'money', L('سعر البيع', 'List price'), req),
      f('status', 'enum', L('الحالة', 'Status'), { values: ['active', 'inactive', 'archived'], default: 'active' }),
      f('category', 'string', L('التصنيف', 'Category')),
      f('duration_min', 'int', L('مدة الخدمة بالدقائق', 'Service duration (minutes)')),
      f('buffer_min', 'int', L('وقت التجهيز بالدقائق', 'Buffer (minutes)'), { default: '0' }),
      f('cost', 'money', L('التكلفة المباشرة للوحدة', 'Direct unit cost')),
      f('has_image', 'bool', L('له صورة', 'Has a photo'), { default: 'false' }),
      f('has_description', 'bool', L('له وصف', 'Has a description'), { default: 'false' }),
      f('visible', 'bool', L('ظاهر للعملاء', 'Visible to customers'), { default: 'true' }),
    ],
    example: { id: 'P-100', kind: 'product', name: 'كريم مرطب', name_en: 'Moisturiser', price: '45.00', status: 'active', cost: '18.50' },
  },
  offering_requirements: {
    entity: 'offering_requirements', key: ['offering_id', 'type', 'ref_id'], doc: L('ما يحتاجه العرض: مواد، مهارة، مورد، مكوّن.', 'What an offering needs: materials, skill, resource, component.'),
    fields: [
      f('offering_id', 'string', L('معرّف العرض', 'Offering id'), req),
      f('type', 'enum', L('النوع', 'Type'), { ...req, values: ['material', 'resource', 'skill', 'time', 'component'] }),
      f('ref_id', 'string', L('المرجع (صنف مخزون أو مورد أو عرض)', 'Reference (stock item, resource or offering)')),
      f('quantity', 'number', L('الكمية', 'Quantity'), { default: '1' }),
      f('unit', 'string', L('الوحدة', 'Unit'), { default: 'unit' }),
      f('confidence', 'enum', L('الثقة', 'Confidence'), { values: ['recipe', 'estimated', 'unknown'], default: 'recipe' }),
    ],
    example: { offering_id: 'S-1', type: 'material', ref_id: 'INV-7', quantity: '20', unit: 'ml', confidence: 'recipe' },
  },
  inventory_items: {
    entity: 'inventory_items', key: ['id'], doc: L('أصناف المخزون: للبيع أو للتشغيل أو كلاهما.', 'Stock items: sellable, consumable or both.'),
    fields: [
      f('id', 'string', L('معرّف الصنف', 'Item id'), req),
      f('name', 'string', L('اسم الصنف', 'Item name'), req),
      f('usage', 'enum', L('الاستخدام', 'Usage'), { ...req, values: ['sellable', 'consumable', 'both'] }),
      f('on_hand', 'number', L('الكمية المتاحة', 'On hand'), req),
      f('reserved', 'number', L('المحجوز', 'Reserved'), { default: '0' }),
      f('unit', 'string', L('الوحدة', 'Unit'), { default: 'unit' }),
      f('unit_cost', 'money', L('تكلفة الوحدة', 'Unit cost')),
      f('reorder_level', 'number', L('حد إعادة الطلب', 'Reorder level')),
      f('offering_id', 'string', L('المنتج المرتبط (للبيع)', 'Linked product offering')),
      f('active', 'bool', L('نشط', 'Active'), { default: 'true' }),
      f('sold_90d', 'number', L('المباع خلال ٩٠ يومًا (يُحسب من المعاملات إن تُرك فارغًا)', 'Sold in 90 days (derived from transactions when empty)')),
      f('consumed_90d', 'number', L('المستهلك خلال ٩٠ يومًا', 'Consumed in 90 days'), { default: '0' }),
    ],
    example: { id: 'INV-7', name: 'Moisturiser 50ml', usage: 'sellable', on_hand: '40', unit: 'unit', unit_cost: '18.50', reorder_level: '10', offering_id: 'P-100' },
  },
  resources: {
    entity: 'resources', key: ['id'], doc: L('الموارد: موظفون، غرف، مركبات توصيل…', 'Resources: staff, rooms, delivery vehicles…'),
    fields: [
      f('id', 'string', L('معرّف المورد', 'Resource id'), req),
      f('kind', 'enum', L('النوع', 'Kind'), { ...req, values: ['staff', 'room', 'equipment', 'table', 'vehicle', 'generic'] }),
      f('type_ref', 'string', L('نوع المورد', 'Resource type')),
      f('skills', 'list', L('معرّفات العروض المؤهل لها (مفصولة بـ |)', 'Offering ids it is qualified for (separated by |)')),
      f('active', 'bool', L('نشط', 'Active'), { default: 'true' }),
    ],
    example: { id: 'STAFF-1', kind: 'staff', skills: 'S-1|S-2', active: 'true' },
  },
  capacity_windows: {
    entity: 'capacity_windows', key: ['resource_id', 'start', 'state'], doc: L('أوقات المورد: متاح أو محجوز أو مغلق أو إجازة.', 'Resource time: free, booked, blocked or leave.'),
    fields: [
      f('resource_id', 'string', L('معرّف المورد', 'Resource id'), req),
      f('start', 'datetime', L('البداية', 'Start'), req),
      f('end', 'datetime', L('النهاية', 'End'), req),
      f('state', 'enum', L('الحالة', 'State'), { ...req, values: ['free', 'booked', 'blocked', 'leave'] }),
    ],
    example: { resource_id: 'STAFF-1', start: '2026-11-10 09:00', end: '2026-11-10 17:00', state: 'free' },
  },
  transactions: {
    entity: 'transactions', key: ['id'], doc: L('المعاملات (حجوزات أو طلبات). الحالة تُوحَّد بخريطة الحالات.', 'Transactions (bookings or orders). Status is normalised by the status map.'),
    fields: [
      f('id', 'string', L('معرّف المعاملة', 'Transaction id'), req),
      f('kind', 'enum', L('النوع', 'Kind'), { values: ['booking', 'order', 'membership', 'gift'], default: 'order' }),
      f('status', 'string', L('الحالة في نظامك', 'Status in your system'), req),
      f('occurred_at', 'datetime', L('وقت المعاملة', 'When it happened'), req),
      f('customer_ref', 'string', L('معرّف العميل المستعار', 'Pseudonymous customer id')),
      f('channel', 'string', L('القناة', 'Channel'), { default: 'in_store' }),
      f('gross', 'money', L('الإجمالي قبل الخصم', 'Gross before discount')),
      f('discount', 'money', L('الخصم', 'Discount'), { default: '0' }),
      f('tax', 'money', L('الضريبة', 'Tax'), { default: '0' }),
      f('total', 'money', L('المبلغ المدفوع', 'Total charged'), req),
      f('refunded', 'money', L('المسترد', 'Refunded'), { default: '0' }),
      f('platform_fee', 'money', L('عمولة المنصة', 'Platform fee'), { default: '0' }),
      f('campaign_id', 'string', L('الحملة', 'Campaign')),
      f('coupon', 'bool', L('بكوبون', 'With a coupon'), { default: 'false' }),
    ],
    example: { id: 'T-1', kind: 'order', status: 'completed', occurred_at: '2026-11-01 18:20', customer_ref: 'C-9', total: '90.00', tax: '11.74' },
  },
  transaction_lines: {
    entity: 'transaction_lines', key: ['transaction_id', 'line_id'], doc: L('بنود المعاملات.', 'Transaction lines.'),
    fields: [
      f('transaction_id', 'string', L('معرّف المعاملة', 'Transaction id'), req),
      f('line_id', 'string', L('معرّف البند (اختياري)', 'Line id (optional)')),
      f('offering_id', 'string', L('معرّف العرض', 'Offering id'), req),
      f('qty', 'number', L('الكمية', 'Quantity'), { default: '1' }),
      f('line_total', 'money', L('إجمالي البند قبل الخصم', 'Line total before discount'), req),
      f('cost_direct', 'money', L('التكلفة المباشرة للبند', 'Direct cost of the line')),
      f('resource_ids', 'list', L('الموارد (مفصولة بـ |)', 'Resources (separated by |)')),
      f('starts_at', 'datetime', L('وقت البدء (للحجوزات)', 'Start (bookings)')),
      f('duration_min', 'int', L('المدة', 'Duration')),
    ],
    example: { transaction_id: 'T-1', offering_id: 'P-100', qty: '2', line_total: '90.00' },
  },
  cost_facts: {
    entity: 'cost_facts', key: ['type', 'scope', 'offering_id'], doc: L('حقائق التكلفة: مواد أو عمولة أو رسوم.', 'Cost facts: materials, commission or fees.'),
    fields: [
      f('type', 'enum', L('النوع', 'Type'), { ...req, values: ['material', 'commission', 'payment_fee', 'platform_fee', 'labor', 'overhead'] }),
      f('scope', 'enum', L('النطاق', 'Scope'), { ...req, values: ['offering', 'services', 'products', 'business'] }),
      f('offering_id', 'string', L('العرض (للنطاق offering)', 'Offering (scope offering)')),
      f('amount', 'money', L('المبلغ للوحدة', 'Amount per unit')),
      f('rate_bp', 'int', L('النسبة بنقاط الأساس', 'Rate in basis points')),
      f('completeness', 'enum', L('الاكتمال', 'Completeness'), { values: ['complete', 'partial', 'missing'], default: 'complete' }),
    ],
    example: { type: 'commission', scope: 'products', rate_bp: '500' },
  },
  demand_signals: {
    entity: 'demand_signals', key: ['type', 'offering_id', 'day'], doc: L('إشارات الطلب اليومية.', 'Daily demand signals.'),
    fields: [
      f('type', 'enum', L('النوع', 'Type'), { ...req, values: ['view', 'booking_start', 'no_availability', 'waitlist', 'waitlist_entry', 'inquiry', 'confirmed', 'page_view'] }),
      f('offering_id', 'string', L('العرض', 'Offering')),
      f('day', 'date', L('اليوم', 'Day'), req),
      f('count', 'int', L('العدد', 'Count'), { default: '1' }),
      f('sessions', 'int', L('الجلسات', 'Sessions'), { default: '0' }),
    ],
    example: { type: 'view', offering_id: 'P-100', day: '2026-11-01', count: '12', sessions: '9' },
  },
  reviews: {
    entity: 'reviews', key: ['id'], doc: L('التقييمات المؤكدة.', 'Verified reviews.'),
    fields: [
      f('id', 'string', L('معرّف التقييم', 'Review id'), req),
      f('rating', 'number', L('التقييم من ٥', 'Rating out of 5'), req),
      f('offering_id', 'string', L('العرض', 'Offering')),
      f('resource_id', 'string', L('المورد', 'Resource')),
      f('verified', 'bool', L('مؤكد', 'Verified'), { default: 'true' }),
      f('at', 'datetime', L('الوقت', 'When'), req),
    ],
    example: { id: 'R-1', rating: '5', offering_id: 'P-100', at: '2026-10-20 12:00' },
  },
  customers: {
    entity: 'customers', key: ['pseudo_id'], doc: L('العملاء بمعرّف مستعار فقط (لا أسماء ولا أرقام ولا بريد).', 'Customers by pseudonymous id only (no names, phones or e-mails).'),
    fields: [
      f('pseudo_id', 'string', L('معرّف مستعار', 'Pseudonymous id'), req),
      f('created_at', 'datetime', L('تاريخ الإنشاء', 'Created at')),
      f('acquisition_source', 'string', L('مصدر الاكتساب', 'Acquisition source')),
      f('segments', 'list', L('الشرائح (مفصولة بـ |)', 'Segments (separated by |)')),
      f('consent_marketing', 'bool', L('موافقة تسويقية', 'Marketing consent'), { default: 'false' }),
      f('dup_key', 'string', L('مفتاح تكرار مُجزّأ (hash) للتواصل', 'Hashed contact key for duplicate detection')),
    ],
    example: { pseudo_id: 'C-9', created_at: '2025-06-01', consent_marketing: 'true', dup_key: 'a1b2c3' },
  },
};

export function templateHeader(entity: SourceEntity) { return TEMPLATES[entity].fields.map((x) => x.field); }

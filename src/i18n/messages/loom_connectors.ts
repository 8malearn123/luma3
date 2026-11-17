/**
 * لووم للتسويق — phase 7: connections (CSV / REST / inbound webhooks), the
 * first-snapshot review gate, outgoing webhooks, sector packs and external
 * (Loom-only) businesses. Arabic is primary; English mirrors every key.
 */
const ar = {
  marketing: { tabs: { connections: 'الربط والبيانات' } },
  loom: { category: { stockout_risk: 'خطر نفاد المخزون' } },
  errors: {
    mapping_required: 'أكملي خطوة الربط (تعريف الأعمدة والحالات والإيراد) أولًا.',
    review_not_ready: 'لا يمكن الاعتماد بعد: أكملي الربط وشغّلي مزامنة تجتاز فحص الجودة.',
    connection_exists: 'يوجد ربط من هذا النوع لهذه المنشأة.',
    connection_paused: 'الربط متوقف مؤقتًا؛ استأنفيه أولًا.',
    connection_review_required: 'مصدر البيانات لم يُعتمد بعد؛ راجعي أول لقطة واعتمديها.',
    sector_pack_disabled: 'هذه الحزمة القطاعية غير مفعّلة من المنصة.',
    unknown_sector_pack: 'حزمة قطاعية غير معروفة.',
    not_a_staged_connection: 'هذا الربط يُقرأ مباشرة ولا يحتاج مزامنة أو ربط أعمدة.',
    not_a_csv_connection: 'رفع الملفات متاح لربط CSV فقط.',
    not_a_rest_connection: 'هذا الإعداد خاص بربط REST.',
    too_many_endpoints: 'خمس نقاط استقبال نشطة كحد أقصى.',
    bad_signature: 'توقيع الطلب غير صحيح.',
    stale_timestamp: 'انتهت صلاحية توقيع الطلب.',
    missing_signature: 'الطلب بلا توقيع.',
  },
  loomc: {
    title: 'الربط والبيانات',
    subtitle: 'اربطي نظامك عبر ملفات CSV أو واجهة REST أو أحداث موقّعة. لا يُستخدم أي مصدر جديد في التحليل قبل تعريف الأعمدة واجتياز فحص الجودة ومراجعتك لأول لقطة.',
    vocabulary: 'مصطلحات القطاع: {offering}، {resource}، {customer}',
    sector: { title: 'الحزمة القطاعية', current: 'الحالية: {name}', change: 'تغيير الحزمة', disabled: 'غير مفعّلة من المنصة' },
    kind: { luma: 'لوما (مباشر)', csv_import: 'ملفات CSV', rest: 'واجهة REST' },
    status: { active: 'نشط', paused: 'متوقف', error: 'خطأ' },
    review: {
      not_required: 'لا يحتاج مراجعة', pending_mapping: 'بانتظار الربط', pending_review: 'بانتظار مراجعتك', approved: 'معتمد', rejected: 'مرفوض',
      title: 'مراجعة أول لقطة', blockers: 'ما يمنع الاعتماد', ready: 'جاهز للاعتماد', approve: 'اعتماد كمصدر للتحليل', reject: 'رفض',
      counts: 'الأعداد', quality: 'جودة البيانات', primary: 'مصدر التحليل',
      blocker: {
        no_active_offerings: 'لا توجد عروض نشطة', no_transactions: 'لا توجد معاملات', unmapped_statuses: 'حالات غير معرّفة في خريطة الحالات',
        quality_insufficient: 'فحص الجودة غير كافٍ', inconsistent_transactions: 'معاملات كثيرة لا تطابق بنودها إجماليها',
      },
    },
    list: { empty: 'لا توجد روابط بعد.', last_sync: 'آخر مزامنة', never: 'لم تتم', records: 'السجلات', health: 'الحالة', last_error: 'آخر خطأ' },
    create: { title: 'ربط جديد', name: 'الاسم', kind: 'النوع', base_url: 'رابط الواجهة (https)', paths: 'المسارات لكل كيان (JSON)', auth: 'المصادقة', secret: 'المفتاح السري (يُحفظ مشفرًا ولا يُعرض)', submit: 'إنشاء', ingest_secret: 'سر توقيع الأحداث الواردة — انسخيه الآن، لن يظهر مرة أخرى:' },
    actions: { test: 'اختبار', sync: 'مزامنة الآن', pause: 'إيقاف مؤقت', resume: 'استئناف', open: 'فتح', close: 'إغلاق', rotate: 'تجديد سر الأحداث' },
    mapping: {
      title: 'ربط الأعمدة والحالات', timezone: 'المنطقة الزمنية', currency: 'العملة', money_unit: 'وحدة المبالغ', major: 'ريال (بالكسور)', minor: 'هللة (أعداد صحيحة)',
      columns: 'الأعمدة (JSON: الكيان ← الحقل ← عمود المصدر)', status_map: 'خريطة الحالات (JSON: حالة المصدر ← الحالة الموحّدة)',
      include_tax: 'المبالغ تشمل الضريبة', subtract_refunds: 'طرح المسترد من الإيراد', after_discount: 'الإجمالي بعد الخصم', save: 'حفظ الربط',
      basis: 'تعريف الإيراد: {text}', invalid_json: 'صيغة JSON غير صحيحة',
    },
    files: { title: 'رفع ملف', entity: 'الكيان', choose: 'اختيار ملف CSV', upload: 'رفع', template: 'تنزيل القالب', valid: 'صالح', invalid: 'غير صالح', applied: 'مطبّق', superseded: 'استُبدل', errors: '{n} أخطاء', rows: '{n} صف' },
    links: { title: 'سجلات مشتبه بتكرارها (لا تُدمج تلقائيًا)', confirm: 'تأكيد', reject: 'ليست مكررة', none: 'لا توجد.' },
    webhooks: {
      title: 'إشعارات صادرة (Webhooks)', subtitle: 'أحداث فقط: اعتماد خطة لا يرسل حملة أبدًا.', url: 'رابط الاستقبال (https)', events: 'الأحداث', add: 'إضافة',
      secret_once: 'سر التوقيع — انسخيه الآن، لن يظهر مرة أخرى:', deactivate: 'إيقاف', deliveries: 'سجل الإرسال', empty: 'لا توجد نقاط استقبال.',
      status: { pending: 'قيد المحاولة', delivered: 'وصل', failed: 'فشل' }, attempts: 'المحاولات',
    },
    external: {
      title: 'منشآت خارج لوما', subtitle: 'منشآت تستخدم لووم فقط (دون حساب لوما). تُدار من هنا حتى يتوفر الدخول الذاتي.',
      name: 'اسم المنشأة', pack: 'الحزمة القطاعية', create: 'إنشاء منشأة', empty: 'لا توجد منشآت خارجية.', analyze: 'تحليل الآن', opportunities: 'الفرص', back: 'رجوع',
    },
  },
};

const en: typeof ar = {
  marketing: { tabs: { connections: 'Connections & data' } },
  loom: { category: { stockout_risk: 'Stock-out risk' } },
  errors: {
    mapping_required: 'Complete the mapping step (columns, statuses, revenue) first.',
    review_not_ready: 'Cannot approve yet: complete the mapping and run a sync that passes the quality review.',
    connection_exists: 'This business already has a connection of this kind.',
    connection_paused: 'The connection is paused; resume it first.',
    connection_review_required: 'The data source is not approved yet; review and approve its first snapshot.',
    sector_pack_disabled: 'This sector pack is not enabled by the platform.',
    unknown_sector_pack: 'Unknown sector pack.',
    not_a_staged_connection: 'This connection is read live and needs no sync or column mapping.',
    not_a_csv_connection: 'File uploads are for CSV connections only.',
    not_a_rest_connection: 'This setting is for REST connections only.',
    too_many_endpoints: 'At most five active endpoints.',
    bad_signature: 'The request signature is invalid.',
    stale_timestamp: 'The request signature has expired.',
    missing_signature: 'The request is not signed.',
  },
  loomc: {
    title: 'Connections & data',
    subtitle: 'Connect your system with CSV files, a REST API or signed events. No new source feeds analyses before its columns are mapped, it passes the quality gate and you review its first snapshot.',
    vocabulary: 'Sector terms: {offering}, {resource}, {customer}',
    sector: { title: 'Sector pack', current: 'Current: {name}', change: 'Change pack', disabled: 'Not enabled by the platform' },
    kind: { luma: 'LUMA (live)', csv_import: 'CSV files', rest: 'REST API' },
    status: { active: 'Active', paused: 'Paused', error: 'Error' },
    review: {
      not_required: 'No review needed', pending_mapping: 'Awaiting mapping', pending_review: 'Awaiting your review', approved: 'Approved', rejected: 'Rejected',
      title: 'First-snapshot review', blockers: 'What blocks approval', ready: 'Ready to approve', approve: 'Approve as the analysis source', reject: 'Reject',
      counts: 'Counts', quality: 'Data quality', primary: 'Analysis source',
      blocker: {
        no_active_offerings: 'No active offerings', no_transactions: 'No transactions', unmapped_statuses: 'Statuses missing from the status map',
        quality_insufficient: 'The quality gate is insufficient', inconsistent_transactions: 'Many transactions whose lines do not match their total',
      },
    },
    list: { empty: 'No connections yet.', last_sync: 'Last sync', never: 'Never', records: 'Records', health: 'Health', last_error: 'Last error' },
    create: { title: 'New connection', name: 'Name', kind: 'Kind', base_url: 'API base URL (https)', paths: 'Path per entity (JSON)', auth: 'Authentication', secret: 'Secret key (stored encrypted, never shown)', submit: 'Create', ingest_secret: 'Inbound event signing secret — copy it now, it will not be shown again:' },
    actions: { test: 'Test', sync: 'Sync now', pause: 'Pause', resume: 'Resume', open: 'Open', close: 'Close', rotate: 'Rotate event secret' },
    mapping: {
      title: 'Columns and statuses', timezone: 'Timezone', currency: 'Currency', money_unit: 'Amount unit', major: 'Major unit (decimals)', minor: 'Minor unit (integers)',
      columns: 'Columns (JSON: entity → field → source column)', status_map: 'Status map (JSON: source status → canonical status)',
      include_tax: 'Amounts include tax', subtract_refunds: 'Subtract refunds from revenue', after_discount: 'Total is after discounts', save: 'Save mapping',
      basis: 'Revenue basis: {text}', invalid_json: 'Invalid JSON',
    },
    files: { title: 'Upload a file', entity: 'Entity', choose: 'Choose a CSV file', upload: 'Upload', template: 'Download template', valid: 'Valid', invalid: 'Invalid', applied: 'Applied', superseded: 'Superseded', errors: '{n} errors', rows: '{n} rows' },
    links: { title: 'Suspected duplicates (never merged automatically)', confirm: 'Confirm', reject: 'Not a duplicate', none: 'None.' },
    webhooks: {
      title: 'Outgoing webhooks', subtitle: 'Events only: approving a plan never sends a campaign.', url: 'Receiver URL (https)', events: 'Events', add: 'Add',
      secret_once: 'Signing secret — copy it now, it will not be shown again:', deactivate: 'Deactivate', deliveries: 'Delivery log', empty: 'No endpoints.',
      status: { pending: 'Retrying', delivered: 'Delivered', failed: 'Failed' }, attempts: 'Attempts',
    },
    external: {
      title: 'Businesses outside LUMA', subtitle: 'Businesses that use Loom only (no LUMA account). Managed here until self-serve sign-in exists.',
      name: 'Business name', pack: 'Sector pack', create: 'Create business', empty: 'No external businesses.', analyze: 'Analyze now', opportunities: 'Opportunities', back: 'Back',
    },
  },
};

export const loomConnectors = { ar, en };

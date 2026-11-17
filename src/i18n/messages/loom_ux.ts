/**
 * لووم للتسويق — owner-facing structure and display (remediation 2026-11:
 * LUMA-AUDIT-021/022/023/024/038/039). Arabic is primary; English mirrors every key.
 */
const ar = {
  loomux: {
    tabs: {
      home: 'الرئيسية', monthly: 'الخطط الشهرية', weekly: 'الخطط الأسبوعية', opportunities: 'الفرص المستمرة', trends: 'الاتجاهات والأدلة',
      results: 'النتائج', campaigns: 'الحملات', setup: 'إعداد لووم', advanced: 'متقدم',
    },
    advanced: {
      title: 'الإعدادات المتقدمة',
      note: 'تفاصيل تقنية لصاحبة النشاط: حالة التحليلات، ربط البيانات، النماذج، وجدولة التحليل. الخطط والفرص تعمل بدونها.',
      sections: { status: 'حالة التحليل', connections: 'الربط والبيانات', models: 'النماذج', preferences: 'الجدولة والتقويم' },
    },
    status: {
      title: 'حالة التحليل',
      explanation: 'كل تحليل وكل إعداد خطة يعمل في الخلفية. إذا فشل أحدها تبقى خططك السابقة كما هي.',
      none: 'لم يُشغَّل أي تحليل بعد.',
      latest: 'آخر تحليل: {status} — {time}',
      stale: 'في الانتظار منذ أكثر من {n} دقائق — قد لا يكون معالج المهام الخلفية يعمل.',
      kind: 'النوع', state: 'الحالة', how: 'الطريقة', created: 'طُلب', started: 'بدأ', finished: 'انتهى', reason: 'السبب',
      kinds: { analysis: 'تحليل بيانات النشاط', plan_monthly: 'إعداد خطة شهرية', plan_weekly: 'إعداد خطة أسبوعية', plan_revision: 'مقترح تعديل خطة', legacy: 'مهمة تسويق سابقة' },
      how_v: { rules: 'بالقواعد (بدون ذكاء اصطناعي)', ai: 'ذكاء اصطناعي', exploratory: 'استكشافي بالقواعد (بيانات قليلة)', standard: 'تحليل بالقواعد', auto: 'تلقائي' },
      reasons: {
        connection_review_required: 'ربط البيانات يحتاج مراجعة.', sector_pack_disabled: 'حزمة القطاع متوقفة.', insufficient_data: 'بيانات غير كافية.',
        analysis_error: 'خطأ غير متوقع أثناء التحليل.', planner_error: 'خطأ غير متوقع أثناء إعداد الخطة.', timeout: 'انتهت المهلة.',
        no_analysis: 'لا يوجد تحليل مكتمل بعد.', no_opportunities: 'لا توجد فرص مثبتة بعد.',
      },
      unknown_reason: 'تعذّر الإكمال.',
    },
    plans: {
      prepare_monthly: 'إعداد خطة الشهر', prepare_weekly: 'إعداد خطة الأسبوع', queued: 'بدأ الإعداد؛ ستظهر الخطة خلال لحظات.',
      empty_monthly: 'لا توجد خطط شهرية بعد.', empty_weekly: 'لا توجد خطط أسبوعية بعد.',
      rules_note: 'هذه الخطط محسوبة بالقواعد من بيانات نشاطك؛ الذكاء الاصطناعي غير متصل في هذه البيئة.',
      evidence_n: 'مبنية على {n} من مؤشرات بياناتك',
      already_in_plan: 'هذه الفرصة موجودة في خطة الشهر بالفعل؛ لم يُضف شيء مكرر.',
    },
    provenance: {
      ai: 'صاغها لووم بالذكاء الاصطناعي', rules: 'أعدّها لووم بالقواعد', regenerated: 'أعاد لووم إعدادها', example: 'مثال — ليس من بياناتك',
      user_edit: 'تعديل منك', user_created: 'أنشأتِها يدويًا', opportunity_added: 'أُضيفت من فرصة اعتمدتِها', revision: 'مقترح تعديل من لووم',
    },
    diff: {
      section: {
        goal: 'الهدف', baseline: 'خط الأساس', initiative: 'مبادرة', activity: 'نشاط', monthly_goal: 'هدف شهري', budget: 'الميزانية', metric: 'مؤشر', dates: 'التواريخ',
        limitations: 'القيود', owner: 'المسؤولة', other: 'تفصيل',
      },
      field: {
        title: 'العنوان', description: 'الوصف', date_from: 'من', date_to: 'إلى', channel: 'القناة', content_idea: 'فكرة المحتوى', capacity_note: 'ملاحظة الطاقة',
        owner: 'المسؤولة', amount_minor: 'المبلغ', status: 'الحالة', assumptions: 'الافتراضات', baseline: 'خط الأساس', proposed_target: 'الهدف المقترح',
        label: 'الاسم', value: 'القيمة', start: 'البداية', end: 'النهاية',
      },
      added: 'أُضيف', removed: 'حُذف', changed: 'تغيّر', before: 'قبل', after: 'بعد',
    },
    units: { minutes: '{n} دقيقة', days: '{n} يوم', rating: '{n} من 5' },
    evidence_sample: 'العيّنة: {n}',
    channel: {
      in_app: 'داخل التطبيق', whatsapp: 'واتساب', sms: 'رسائل نصية', email: 'البريد', instagram: 'إنستغرام', tiktok: 'تيك توك', snapchat: 'سناب شات',
      storefront: 'المتجر الإلكتروني', in_store: 'داخل المحل',
    },
  },
};

const en: typeof ar = {
  loomux: {
    tabs: {
      home: 'Home', monthly: 'Monthly plans', weekly: 'Weekly plans', opportunities: 'Ongoing opportunities', trends: 'Trends & evidence',
      results: 'Results', campaigns: 'Campaigns', setup: 'Loom setup', advanced: 'Advanced',
    },
    advanced: {
      title: 'Advanced settings',
      note: 'Technical details for the business owner: analysis status, data connections, models and analysis scheduling. Plans and opportunities work without them.',
      sections: { status: 'Analysis status', connections: 'Connections & data', models: 'Models', preferences: 'Schedule & calendar' },
    },
    status: {
      title: 'Analysis status',
      explanation: 'Every analysis and plan preparation runs in the background. If one fails, your previous plans stay exactly as they were.',
      none: 'No analysis has run yet.',
      latest: 'Latest analysis: {status} — {time}',
      stale: 'Queued for more than {n} minutes — the background job worker may not be running.',
      kind: 'Type', state: 'Status', how: 'Method', created: 'Requested', started: 'Started', finished: 'Finished', reason: 'Reason',
      kinds: { analysis: 'Business data analysis', plan_monthly: 'Monthly plan preparation', plan_weekly: 'Weekly plan preparation', plan_revision: 'Plan revision proposal', legacy: 'Earlier marketing job' },
      how_v: { rules: 'Rules-based (no AI)', ai: 'AI', exploratory: 'Rules-based, exploratory (little data)', standard: 'Rules-based analysis', auto: 'Automatic' },
      reasons: {
        connection_review_required: 'The data connection needs a review.', sector_pack_disabled: 'The sector pack is switched off.', insufficient_data: 'Not enough data.',
        analysis_error: 'Unexpected error during the analysis.', planner_error: 'Unexpected error while preparing the plan.', timeout: 'Timed out.',
        no_analysis: 'No completed analysis yet.', no_opportunities: 'No confirmed opportunities yet.',
      },
      unknown_reason: 'Could not complete.',
    },
    plans: {
      prepare_monthly: 'Prepare monthly plan', prepare_weekly: 'Prepare weekly plan', queued: 'Preparation started; the plan will appear in a moment.',
      empty_monthly: 'No monthly plans yet.', empty_weekly: 'No weekly plans yet.',
      rules_note: 'These plans are computed by rules from your business data; AI is not connected in this environment.',
      evidence_n: 'Based on {n} of your data indicators',
      already_in_plan: 'This opportunity is already in this month’s plan; nothing was duplicated.',
    },
    provenance: {
      ai: 'Worded by Loom with AI', rules: 'Prepared by Loom with rules', regenerated: 'Re-prepared by Loom', example: 'Example — not your data',
      user_edit: 'Edited by you', user_created: 'Created by you', opportunity_added: 'Added from an opportunity you approved', revision: 'Revision proposed by Loom',
    },
    diff: {
      section: {
        goal: 'Goal', baseline: 'Baseline', initiative: 'Initiative', activity: 'Activity', monthly_goal: 'Monthly goal', budget: 'Budget', metric: 'Indicator', dates: 'Dates',
        limitations: 'Limitations', owner: 'Owner', other: 'Detail',
      },
      field: {
        title: 'Title', description: 'Description', date_from: 'From', date_to: 'To', channel: 'Channel', content_idea: 'Content idea', capacity_note: 'Capacity note',
        owner: 'Owner', amount_minor: 'Amount', status: 'Status', assumptions: 'Assumptions', baseline: 'Baseline', proposed_target: 'Proposed target',
        label: 'Name', value: 'Value', start: 'Start', end: 'End',
      },
      added: 'Added', removed: 'Removed', changed: 'Changed', before: 'Before', after: 'After',
    },
    units: { minutes: '{n} min', days: '{n} days', rating: '{n} of 5' },
    evidence_sample: 'Sample: {n}',
    channel: {
      in_app: 'In app', whatsapp: 'WhatsApp', sms: 'SMS', email: 'Email', instagram: 'Instagram', tiktok: 'TikTok', snapchat: 'Snapchat',
      storefront: 'Online store', in_store: 'In store',
    },
  },
};

export const loomUx = { ar, en };

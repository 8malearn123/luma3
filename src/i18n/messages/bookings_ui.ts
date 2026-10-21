/** Strings for the dashboard bookings screens (list, calendar, detail, new booking) and the staff portal (/me). Shared booking labels live in operations.ts (booking.*, staff_portal.*). */
const ar = {
  bookings_ui: {
    view: 'طريقة العرض',
    empty_hint: 'غيّري الفترة أو الحالة أو البحث لعرض حجوزات أخرى.',
    filters: { all_staff: 'كل الأخصائيات', all_branches: 'كل الفروع', period: 'الفترة', range: 'فترة محددة' },
    source: { storefront: 'من المتجر', dashboard: 'من لوحة التحكم', walk_in: 'حضور مباشر', waitlist: 'من قائمة الانتظار' },
    cancel_source: { customer: 'العميلة', business: 'النشاط', system: 'النظام' },
    event_source: { staff: 'فريق العمل', customer: 'العميلة', system: 'النظام', payment: 'الدفع', storefront: 'المتجر', dashboard: 'لوحة التحكم', walk_in: 'حضور مباشر', waitlist: 'قائمة الانتظار' },
    event: { created: 'تم إنشاء الحجز', rescheduled: 'تم تغيير الموعد', status: 'الحالة: {status}' },
    reason: {
      hold_expired: 'انتهت مدة الحجز المؤقت', pay_on_site: 'الدفع في الصالون', payment_captured: 'تم استلام الدفعة', staff_confirmed_pay_on_site: 'أكّده الفريق مع الدفع في الصالون',
      late_payment_reallocated: 'وصلت الدفعة متأخرة وأُعيد حجز الوقت نفسه', online_full: 'بانتظار الدفع الإلكتروني الكامل', online_deposit: 'بانتظار دفع العربون',
    },
    method: { cash: 'نقداً', pos_terminal: 'جهاز الدفع', card: 'بطاقة', mada: 'مدى', apple_pay: 'Apple Pay', gift_card: 'بطاقة هدية', sandbox: 'دفع تجريبي' },
    payment: { captured: 'مكتملة', pending: 'قيد المعالجة', authorized: 'مفوّضة', failed: 'فشلت', cancelled: 'ملغاة', refunded: 'مستردة', deposit: 'عربون', reconcile: 'تحتاج مطابقة' },
    calendar: {
      day: 'يوم', week: 'أسبوع', prev_week: 'الأسبوع السابق', next_week: 'الأسبوع التالي', hold: 'حجز مؤقت', legend: 'دليل الألوان',
      hidden_note: 'الحجوزات الملغاة والمنتهية لا تظهر في التقويم.', truncated: 'عدد الحجوزات كبير؛ يُعرض جزء منها فقط. ضيّقي التصفية.',
    },
    detail: {
      hold_until: 'هذا الوقت محجوز مؤقتاً حتى {time}.', needs_approval: 'هذا الحجز ينتظر موافقتكم.', cancelled_by: 'ألغته: {who}', has_account: 'لديها حساب لوما',
      customer_private: 'ملاحظات خاصة', minutes: '{n} دقيقة', deposit_due: 'العربون المطلوب', balance: 'المتبقي', reason_hint: '٣ أحرف على الأقل. يظهر السبب في سجل الحجز.',
      only_service_day: 'تسجيل الحضور وبدء الخدمة متاحان في يوم الموعد فقط.', no_show_after: 'يمكن تسجيل عدم الحضور بعد {time}.',
      done: 'تم تحديث الحجز.', done_refund: 'تم تحديث الحجز. مبلغ مستحق للاسترداد حسب السياسة: {amount}.',
    },
    confirm: {
      title: '{action}؟',
      approve: 'سيتم تأكيد الحجز {number} وإشعار العميلة.', reject: 'سيتم رفض الطلب {number} وإلغاؤه وتحرير الوقت.', check_in: 'تسجيل وصول العميلة للحجز {number}.',
      start: 'بدء تقديم الخدمة للحجز {number}.', complete: 'إنهاء الحجز {number}. يُسجَّل الإيراد عند الإكمال.', no_show: 'تسجيل عدم حضور العميلة للحجز {number} وتحرير الوقت.',
      cancel: 'سيتم إلغاء الحجز {number} وتحرير الوقت. يُحسب أي استرداد حسب سياسة الإلغاء المحفوظة مع الحجز.',
    },
    collect: { balance: 'المتبقي على الحجز: {amount}', reference_hint: 'رقم إيصال الجهاز أو رقم مرجع داخلي للنقد.', done: 'تم تسجيل الدفعة.' },
    refund: {
      list: 'طلبات الاسترداد', payment: 'الدفعة', refundable: 'المتاح للاسترداد من هذه الدفعة: {amount}', nothing: 'لا يوجد مبلغ متاح للاسترداد.',
      submit: 'إرسال طلب الاسترداد', submit_approved: 'استرداد الآن', note_request: 'يحتاج الطلب موافقة من لديها صلاحية اعتماد الاسترداد.', note_approver: 'لديكِ صلاحية الاعتماد، لذا يُنفَّذ الاسترداد مباشرة.',
      requested: 'تم إرسال طلب الاسترداد للموافقة.', sent: 'تم تنفيذ الاسترداد.', approve: 'اعتماد الاسترداد', approve_title: 'اعتماد استرداد {amount}؟',
      approve_body: 'سيُعاد المبلغ بنفس طريقة الدفع الأصلية (النقد يُسلَّم في الصالون). لا يمكن التراجع.', by_policy: 'حسب السياسة',
      status: { requested: 'بانتظار الموافقة', pending: 'قيد التنفيذ', succeeded: 'تم', failed: 'فشل', cancelled: 'ملغى' },
    },
    reschedule: {
      intro: 'اختاري موعداً جديداً. يبقى الموعد الحالي محجوزاً إلى أن يتم الحجز الجديد بنجاح.', keep_staff: 'نفس الأخصائية', submit: 'تأكيد الموعد الجديد',
      accept_price: 'قبول السعر الجديد والتأكيد', done: 'تم تغيير الموعد.',
    },
    docs: {
      title: 'الإيصالات والفواتير', receipt_n: 'إيصال الدفعة {n}', issue_receipt: 'إصدار إيصال', issue_invoice: 'إصدار فاتورة', pdf: 'PDF', print: 'نسخة للطباعة',
      note: 'تُصدر المستندات مرة واحدة ولا تتغير؛ إعادة الإصدار تعرض المستند نفسه.',
    },
    slots: { pick_service_first: 'اختاري الخدمة أولاً لعرض الأوقات المتاحة.', gap: 'فاصل {n} دقيقة' },
    new: {
      change: 'تغيير', customer_search: 'ابحثي بالاسم أو الجوال أو البريد', no_customers: 'لا توجد عميلة مطابقة.', add_customer: 'إضافة العميلة',
      phone_hint: 'يُحفظ للتواصل فقط؛ لا يُربط بأي حساب لوما.', no_customer_access: 'ليست لديكِ صلاحية عرض العميلات أو إضافتهن.',
      no_services: 'لا توجد خدمات متاحة للحجز.', service_n: 'الخدمة {n}', variant: 'الخيار', base_variant: 'الخيار الأساسي', addons: 'إضافات',
      details: 'التفاصيل', internal_hint: 'تظهر لفريق العمل فقط.', payment_mode: 'الدفع',
      confirm_on_site_hint: 'يُؤكَّد الحجز الآن ويُدفع في الصالون، إن كانت شروط العميلة تسمح بذلك.', hold_only_hint: 'يبقى الوقت محجوزاً مؤقتاً حتى تدفع العميلة إلكترونياً.',
      created: 'تم إنشاء الحجز {number}', open_booking: 'فتح الحجز',
    },
  },
  me_portal: {
    no_today: 'لا مواعيد لكِ اليوم.', upcoming: 'المواعيد القادمة (١٤ يوماً)', schedule: 'جدولي', weekly: 'ساعات العمل الأسبوعية',
    schedule_readonly: 'للاطلاع فقط. لتعديل الجدول تواصلي مع الإدارة.', day_off: 'إجازة', break: 'استراحة', overrides: 'تغييرات قادمة على الجدول', no_overrides: 'لا توجد تغييرات قادمة.',
    override: { off: 'يوم إجازة', replace: 'ساعات بديلة', extra: 'ساعات إضافية' },
    attendance: 'الحضور', not_clocked_in: 'لم تسجّلي الحضور بعد.', clocked_out_at: 'آخر انصراف: {time}', clock_out_confirm: 'تسجيل الانصراف الآن؟',
    leave_sent: 'تم إرسال طلب الإجازة.', leave_range_invalid: 'تاريخ النهاية يجب أن يكون بعد البداية.', no_leave: 'لا توجد طلبات إجازة.',
    leave_status: { requested: 'بانتظار الموافقة', approved: 'معتمدة', rejected: 'مرفوضة', cancelled: 'ملغاة' },
    photo: 'الصورة', arabic: 'بالعربية', english: 'بالإنجليزية', profile_note: 'الاسم والمسمى تعدّلهما الإدارة. تظهر النبذة في المتجر إن كان ملفكِ ظاهراً.',
  },
};

type Shape<T> = { [K in keyof T]: T[K] extends string ? string : Shape<T[K]> };

const en: Shape<typeof ar> = {
  bookings_ui: {
    view: 'View',
    empty_hint: 'Change the period, status or search to see other bookings.',
    filters: { all_staff: 'All specialists', all_branches: 'All branches', period: 'Period', range: 'Date range' },
    source: { storefront: 'Storefront', dashboard: 'Dashboard', walk_in: 'Walk-in', waitlist: 'Waitlist' },
    cancel_source: { customer: 'the customer', business: 'the business', system: 'the system' },
    event_source: { staff: 'Team', customer: 'Customer', system: 'System', payment: 'Payment', storefront: 'Storefront', dashboard: 'Dashboard', walk_in: 'Walk-in', waitlist: 'Waitlist' },
    event: { created: 'Booking created', rescheduled: 'Rescheduled', status: 'Status: {status}' },
    reason: {
      hold_expired: 'The hold expired', pay_on_site: 'Pay at the salon', payment_captured: 'Payment received', staff_confirmed_pay_on_site: 'Confirmed by the team, pay at the salon',
      late_payment_reallocated: 'Late payment; the same time was re-booked', online_full: 'Awaiting full online payment', online_deposit: 'Awaiting deposit payment',
    },
    method: { cash: 'Cash', pos_terminal: 'Card terminal', card: 'Card', mada: 'mada', apple_pay: 'Apple Pay', gift_card: 'Gift card', sandbox: 'Test payment' },
    payment: { captured: 'Completed', pending: 'Processing', authorized: 'Authorized', failed: 'Failed', cancelled: 'Cancelled', refunded: 'Refunded', deposit: 'Deposit', reconcile: 'Needs reconciliation' },
    calendar: {
      day: 'Day', week: 'Week', prev_week: 'Previous week', next_week: 'Next week', hold: 'Hold', legend: 'Legend',
      hidden_note: 'Cancelled and expired bookings are not shown in the calendar.', truncated: 'Too many bookings; only part is shown. Narrow the filters.',
    },
    detail: {
      hold_until: 'This time is held until {time}.', needs_approval: 'This booking is waiting for your approval.', cancelled_by: 'Cancelled by {who}', has_account: 'Has a LUMA account',
      customer_private: 'Private notes', minutes: '{n} min', deposit_due: 'Deposit due', balance: 'Balance', reason_hint: 'At least 3 characters. The reason is kept in the booking history.',
      only_service_day: 'Check-in and starting the service are only possible on the appointment day.', no_show_after: 'A no-show can be recorded after {time}.',
      done: 'Booking updated.', done_refund: 'Booking updated. Refund due under the policy: {amount}.',
    },
    confirm: {
      title: '{action}?',
      approve: 'Booking {number} will be confirmed and the customer notified.', reject: 'Request {number} will be declined, cancelled and its time released.', check_in: 'Record that the customer of {number} has arrived.',
      start: 'Start the service for {number}.', complete: 'Complete {number}. Revenue is recorded on completion.', no_show: 'Record a no-show for {number} and release the time.',
      cancel: 'Booking {number} will be cancelled and its time released. Any refund follows the cancellation policy saved with the booking.',
    },
    collect: { balance: 'Balance on this booking: {amount}', reference_hint: 'Terminal receipt number, or an internal reference for cash.', done: 'Payment recorded.' },
    refund: {
      list: 'Refunds', payment: 'Payment', refundable: 'Refundable from this payment: {amount}', nothing: 'Nothing is available to refund.',
      submit: 'Send refund request', submit_approved: 'Refund now', note_request: 'The request needs approval from someone who can approve refunds.', note_approver: 'You can approve refunds, so it is processed right away.',
      requested: 'Refund request sent for approval.', sent: 'Refund processed.', approve: 'Approve refund', approve_title: 'Approve a refund of {amount}?',
      approve_body: 'The amount goes back via the original payment method (cash is handed back at the salon). This cannot be undone.', by_policy: 'Per policy',
      status: { requested: 'Awaiting approval', pending: 'Processing', succeeded: 'Done', failed: 'Failed', cancelled: 'Cancelled' },
    },
    reschedule: {
      intro: 'Choose a new time. The current appointment stays booked until the new one is secured.', keep_staff: 'Same specialist', submit: 'Confirm new time',
      accept_price: 'Accept new price and confirm', done: 'Appointment rescheduled.',
    },
    docs: {
      title: 'Receipts & invoices', receipt_n: 'Receipt for payment {n}', issue_receipt: 'Issue receipt', issue_invoice: 'Issue invoice', pdf: 'PDF', print: 'Print view',
      note: 'Documents are issued once and never change; issuing again shows the same document.',
    },
    slots: { pick_service_first: 'Choose a service first to see available times.', gap: '{n}-minute gap' },
    new: {
      change: 'Change', customer_search: 'Search by name, mobile or email', no_customers: 'No matching customer.', add_customer: 'Add customer',
      phone_hint: 'Kept for contact only; never linked to a LUMA account.', no_customer_access: 'You do not have access to view or add customers.',
      no_services: 'No services are available for booking.', service_n: 'Service {n}', variant: 'Option', base_variant: 'Standard', addons: 'Add-ons',
      details: 'Details', internal_hint: 'Visible to the team only.', payment_mode: 'Payment',
      confirm_on_site_hint: 'Confirm now and pay at the salon, if the customer’s terms allow it.', hold_only_hint: 'Keep the time on hold until the customer pays online.',
      created: 'Booking {number} created', open_booking: 'Open booking',
    },
  },
  me_portal: {
    no_today: 'No appointments for you today.', upcoming: 'Upcoming (next 14 days)', schedule: 'My schedule', weekly: 'Weekly working hours',
    schedule_readonly: 'Read-only. Contact management to change your schedule.', day_off: 'Day off', break: 'Break', overrides: 'Upcoming schedule changes', no_overrides: 'No upcoming changes.',
    override: { off: 'Day off', replace: 'Replacement hours', extra: 'Extra hours' },
    attendance: 'Attendance', not_clocked_in: 'You have not clocked in yet.', clocked_out_at: 'Last clock-out: {time}', clock_out_confirm: 'Clock out now?',
    leave_sent: 'Leave request sent.', leave_range_invalid: 'The end date must be on or after the start date.', no_leave: 'No leave requests.',
    leave_status: { requested: 'Awaiting approval', approved: 'Approved', rejected: 'Declined', cancelled: 'Cancelled' },
    photo: 'Photo', arabic: 'Arabic', english: 'English', profile_note: 'Your name and title are managed by the business. Your bio appears in the store if your profile is public.',
  },
};

export const bookingsUi = { ar, en };

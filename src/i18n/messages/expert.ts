/** Expert experience: expert workspace labels, event bookings, portfolio, Instagram. */
const ar = {
  nav: { events: 'حجوزات المناسبات', portfolio: 'معرض الأعمال' },
  builder: {
    f: { source: 'المصدر', category: 'التصنيف', start: 'موضع الفاصل عند الفتح (%)', show_labels: 'إظهار «قبل» و«بعد»', show_follow: 'إظهار زر المتابعة', follow_text: 'نص زر المتابعة' },
    o: { items: 'صور أختارها', portfolio: 'من معرض الأعمال' },
  },
  storefront: {
    expert: {
      ba: {
        empty: 'أضيفي صورتين (قبل وبعد) لعرض المقارنة', item: 'العمل {n}', before: 'قبل', after: 'بعد',
        before_alt: 'قبل: {name}', after_alt: 'بعد: {name}', slider: 'مقارنة قبل وبعد: {name}', value_text: 'يظهر {n}% من صورة «قبل»',
      },
      ig: {
        empty: 'أضيفي حساب إنستقرام من خصائص القسم أو من روابط التواصل', follow: 'تابعينا على إنستقرام', follow_title: 'تابعينا على إنستقرام',
        post_alt: 'منشور من إنستقرام @{handle}', open_post: 'فتح المنشور على إنستقرام: {caption}',
      },
      ev: {
        title: 'حجوزات المناسبات', cta: 'اطلبي عرض سعر', disabled: 'حجوزات المناسبات متوقفة حالياً (من صفحة حجوزات المناسبات ← الإعدادات)',
        deposit_note: 'يتأكد الحجز بدفع عربون (عادةً {pct}%) والمتبقي يوم المناسبة.',
      },
    },
  },
  expert: {
    nav: {
      bookings: 'مواعيدي', customers: 'عميلاتي', services: 'خدماتي', products: 'منتجاتي', team: 'مساعداتي', builder: 'متجري', portfolio: 'أعمالي', me: 'جدولي',
    },
    titles: {
      bookings: 'مواعيدي', customers: 'عميلاتي', services: 'خدماتي', products: 'منتجاتي', team: 'مساعداتي',
      team_subtitle: 'أضيفي مساعداتكِ، وحدّدي جداولهن وخدماتهن وصلاحياتهن.', portfolio: 'أعمالي', studio: 'الاستوديو وساعات العمل',
    },
    occasions: { wedding: 'زواج', engagement: 'ملكة / خطوبة', graduation: 'تخرج', group_makeup: 'مكياج جماعي', party: 'حفلة', other: 'مناسبة أخرى' },
    events: {
      title: 'حجوزات المناسبات',
      subtitle: 'طلبات الزواج والتخرج والمكياج الجماعي: أرسلي عرض السعر، وتتأكد المناسبة بدفع العربون أونلاين ويُحجز وقتكِ تلقائياً.',
      settings: 'إعدادات المناسبات', settings_saved: 'تم حفظ إعدادات المناسبات',
      views: { requests: 'طلبات جديدة', quotes: 'عروض مرسلة', upcoming: 'مؤكدة', closed: 'منتهية' },
      empty: { requests: 'لا توجد طلبات جديدة', quotes: 'لا توجد عروض بانتظار العميلات', upcoming: 'لا توجد مناسبات مؤكدة', closed: 'لا توجد مناسبات منتهية' },
      empty_hint: 'أضيفي قسم «حجز المناسبات» في متجركِ ليصلكِ الطلب هنا.',
      status: {
        requested: 'طلب جديد', quoted: 'عرض مرسل', pending_payment: 'بانتظار العربون', confirmed: 'مؤكدة', completed: 'مكتملة', declined: 'مرفوض', expired: 'منتهي الصلاحية', cancelled: 'ملغاة',
      },
      location: { venue: 'في القاعة / الموقع', studio: 'في الاستوديو' },
      people: '{n} أشخاص', people_label: 'عدد الأشخاص', when: 'الموعد', where: 'المكان', customer: 'العميلة', services: 'الخدمات', specialist: 'الخبيرة',
      total: 'الإجمالي', deposit: 'العربون', paid: 'المدفوع', refunded: 'المسترد', balance_due: 'المتبقي يوم المناسبة', tax_included: 'منها ضريبة',
      quote_valid_until: 'العرض صالح حتى {when}', declined_because: 'سبب الرفض: {reason}',
      cancelled_by: { customer: 'ألغتها العميلة', business: 'ألغيتِها', system: 'أُلغيت تلقائياً' },
      payments: 'المدفوعات',
      pay_kind: { deposit: 'عربون', balance: 'المتبقي', full: 'كامل المبلغ', on_site: 'في الموقع' },
      pay_status: { pending: 'قيد الإنشاء', requires_action: 'بانتظار الدفع', authorized: 'مفوَّض', captured: 'مدفوع', failed: 'فشل', cancelled: 'ملغى', expired: 'منتهي' },
      send_quote: 'إرسال عرض السعر', revise_quote: 'تعديل العرض', decline: 'اعتذار عن الطلب', cancel: 'إلغاء المناسبة',
      cancel_refund_note: 'سيتم استرداد كل ما دفعته العميلة ({amount}) لأن الإلغاء من طرفكِ.',
      collect_balance: 'تسجيل استلام المتبقي', balance_ok: 'تم تسجيل المبلغ', complete: 'تمت المناسبة', completed_ok: 'تم إكمال المناسبة',
      quote_sent: 'تم إرسال العرض للعميلة', busy: 'لديكِ موعد أو إجازة في هذا الوقت. اختاري خبيرة أخرى أو اعتذري عن الطلب.',
      price: 'سعر المناسبة', price_hint: 'مجموع الخدمات المطلوبة × عدد الأشخاص: {amount}', duration_hours: 'المدة (بالساعات)',
      prep_min: 'وقت التجهيز والتنقل قبلها (دقيقة)', prep_hint: 'يُحجز من وقتكِ أيضاً حتى لا يُحجز فوقه.',
      deposit_percent: 'نسبة من الإجمالي (%)', deposit_fixed: 'مبلغ ثابت', deposit_preview: 'العربون: {amount}',
      valid_days: 'صلاحية العرض (أيام)', quote_note: 'ملاحظة للعميلة (اختياري)',
      quote_explainer: 'تصل العميلة رسالة بالعرض. عند قبولها يُحجز وقتكِ مؤقتاً لحين دفع العربون، ثم يتأكد الحجز تلقائياً.',
      amount: 'المبلغ', method: 'طريقة الدفع', methods: { cash: 'نقداً', pos_terminal: 'شبكة' }, reference: 'رقم المرجع / الإيصال',
      s: {
        enabled: 'استقبال طلبات المناسبات من المتجر', default_deposit: 'العربون الافتراضي (%)', free_cancellation_days: 'الإلغاء المجاني قبل المناسبة بـ (أيام)',
        free_cancellation_hint: 'إذا ألغت العميلة بعد ذلك يبقى العربون لكِ. تُطبّق السياسة المحفوظة وقت إرسال العرض.',
        quote_validity_days: 'صلاحية العرض الافتراضية (أيام)', max_people: 'أقصى عدد أشخاص في الطلب', intro_ar: 'نص تعريفي في صفحة الطلب (عربي)', intro_en: 'نص تعريفي في صفحة الطلب (إنجليزي)',
      },
    },
    sf: {
      title: 'حجوزات المناسبات', intro: 'زواج، تخرج، مكياج جماعي… أرسلي تفاصيل مناسبتكِ وسنرسل لكِ عرض السعر.',
      my_requests: 'طلباتي', sign_in: 'سجّلي الدخول لإرسال طلب ومتابعة عرض السعر.',
      occasion: 'نوع المناسبة', date: 'التاريخ', time: 'وقت البدء', time_hint: 'بتوقيت النشاط', location: 'المكان', venue: 'عنوان القاعة أو الموقع',
      venue_placeholder: 'اسم القاعة، الحي، المدينة', people: 'عدد الأشخاص', people_hint: 'بحد أقصى {n}', services: 'الخدمات المطلوبة (اختياري)',
      notes: 'تفاصيل إضافية', notes_placeholder: 'مثلاً: عروس + ٣ مرافقات، تسريحة ومكياج', phone: 'رقم للتواصل (اختياري)', phone_hint: 'نستخدمه للتنسيق فقط.',
      how_it_works: 'بعد إرسال الطلب يصلكِ عرض السعر، ويتأكد الحجز بدفع العربون أونلاين. الإلغاء المجاني حتى {days} يوماً قبل المناسبة.',
      submit: 'إرسال الطلب',
      status: { requested: 'بانتظار العرض', quoted: 'وصل العرض', pending_payment: 'بانتظار الدفع', confirmed: 'مؤكد', completed: 'مكتمل', declined: 'معتذر عنه', expired: 'منتهي', cancelled: 'ملغى' },
      status_long: {
        requested: 'استلمنا طلبكِ وسنرسل لكِ عرض السعر قريباً.', quoted: 'وصلكِ عرض السعر. ادفعي العربون لتأكيد الحجز.', pending_payment: 'جارٍ التحقق من دفع العربون…',
        confirmed: 'تم تأكيد حجز مناسبتكِ 🎉', completed: 'تمت المناسبة. شكراً لكِ!', declined: 'نعتذر، لا يمكننا تلبية هذا الطلب.', expired: 'انتهت صلاحية العرض. تواصلي معنا لعرض جديد.', cancelled: 'تم إلغاء الحجز.',
      },
      quote: 'عرض السعر', until: 'حتى {when}', deposit_now: 'العربون الآن', balance_on_day: 'المتبقي يوم المناسبة',
      valid_until: 'العرض صالح حتى {when}', policy: 'الإلغاء المجاني حتى {days} يوماً قبل المناسبة، وبعدها لا يُسترد العربون.',
      accept_pay: 'قبول العرض ودفع العربون {amount}', confirmed_note: 'المتبقي يُدفع يوم المناسبة.',
      quote_changed: 'تم تحديث العرض. راجعيه قبل الدفع.', cancel: 'إلغاء الطلب', cancel_reason: 'سبب الإلغاء', confirm_cancel: 'تأكيد الإلغاء',
      late_cancel_warning: 'الإلغاء الآن بعد انتهاء مدة الإلغاء المجاني، فلا يُسترد العربون.', back: 'كل طلبات المناسبات',
    },
    portfolio: {
      title: 'معرض الأعمال', subtitle: 'صور قبل وبعد لأعمالكِ. تظهر في المتجر عبر قسم «قبل وبعد».',
      builder_hint: 'لعرضها في المتجر أضيفي قسم «قبل وبعد» واختاري مصدر الأعمال من', add: 'إضافة عمل', added: 'تمت إضافة العمل', deleted: 'تم حذف العمل',
      empty: 'لا توجد أعمال بعد', empty_hint: 'أضيفي صورة «قبل» وصورة «بعد» لكل عمل.', hidden: 'مخفي', hide: 'إخفاء من المتجر', show: 'إظهار في المتجر',
      single: 'صورة واحدة', untitled: 'بدون عنوان', caption_ar: 'التعليق (عربي)', caption_en: 'التعليق (إنجليزي)', category: 'التصنيف',
      category_hint: 'مثل: عرائس، سهرة، شعر. يمكنكِ عرض تصنيف واحد في القسم.', delete_title: 'حذف هذا العمل؟', delete_body: 'سيختفي من المتجر. الصور نفسها تبقى في مكتبة الصور.',
    },
    ba: {
      pairs: 'الأعمال', before: 'قبل', after: 'بعد', before_optional: 'صورة «قبل» (اختياري)', add_pair: 'إضافة عمل (قبل وبعد)',
      from_portfolio: 'يعرض هذا القسم الأعمال من صفحة معرض الأعمال (التي لها صورة قبل وبعد).',
      o_portfolio: 'من «أعمالي»',
    },
    ig: {
      account: 'حساب إنستقرام', handle: 'اسم المستخدم', handle_hint: 'يظهر رابط حسابكِ في المتجر حتى لو لم يكن مربوطاً.',
      from_social: 'من روابط التواصل: @{handle}', not_configured: 'عرض آخر المنشورات يتطلب ربطاً رسمياً مع إنستقرام وسيتوفر قريباً. حالياً يظهر زر «تابعينا على إنستقرام».',
      sync_error: 'تعذّر تحديث المنشورات من إنستقرام. نعرض آخر منشورات محفوظة.',
      status: { not_connected: 'غير مربوط', connected: 'مربوط', error: 'خطأ في الربط' },
    },
  },
};

const en: typeof ar = {
  nav: { events: 'Event bookings', portfolio: 'Portfolio' },
  builder: {
    f: { source: 'Source', category: 'Category', start: 'Divider start position (%)', show_labels: 'Show “Before” and “After”', show_follow: 'Show follow button', follow_text: 'Follow button text' },
    o: { items: 'Images I choose', portfolio: 'From the portfolio' },
  },
  storefront: {
    expert: {
      ba: {
        empty: 'Add a before and an after image to show the comparison', item: 'Work {n}', before: 'Before', after: 'After',
        before_alt: 'Before: {name}', after_alt: 'After: {name}', slider: 'Before and after comparison: {name}', value_text: '{n}% of the before image shown',
      },
      ig: {
        empty: 'Add an Instagram account in the section settings or your social links', follow: 'Follow us on Instagram', follow_title: 'Follow us on Instagram',
        post_alt: 'Instagram post from @{handle}', open_post: 'Open the post on Instagram: {caption}',
      },
      ev: {
        title: 'Event bookings', cta: 'Request a quote', disabled: 'Event bookings are switched off (Event bookings → Settings)',
        deposit_note: 'A deposit (usually {pct}%) confirms the booking; the balance is due on the day.',
      },
    },
  },
  expert: {
    nav: {
      bookings: 'My appointments', customers: 'My clients', services: 'My services', products: 'My products', team: 'My assistants', builder: 'My store', portfolio: 'My work', me: 'My schedule',
    },
    titles: {
      bookings: 'My appointments', customers: 'My clients', services: 'My services', products: 'My products', team: 'My assistants',
      team_subtitle: 'Add your assistants and set their schedules, services and access.', portfolio: 'My work', studio: 'Studio & opening hours',
    },
    occasions: { wedding: 'Wedding', engagement: 'Engagement', graduation: 'Graduation', group_makeup: 'Group makeup', party: 'Party', other: 'Other occasion' },
    events: {
      title: 'Event bookings',
      subtitle: 'Weddings, graduations and group makeup: send a quote; the event is confirmed when the deposit is paid online and your time is reserved automatically.',
      settings: 'Event settings', settings_saved: 'Event settings saved',
      views: { requests: 'New requests', quotes: 'Quotes sent', upcoming: 'Confirmed', closed: 'Closed' },
      empty: { requests: 'No new requests', quotes: 'No quotes awaiting customers', upcoming: 'No confirmed events', closed: 'No closed events' },
      empty_hint: 'Add the “Event bookings” section to your store to receive requests here.',
      status: {
        requested: 'New request', quoted: 'Quote sent', pending_payment: 'Awaiting deposit', confirmed: 'Confirmed', completed: 'Completed', declined: 'Declined', expired: 'Expired', cancelled: 'Cancelled',
      },
      location: { venue: 'At the venue', studio: 'At the studio' },
      people: '{n} people', people_label: 'People', when: 'When', where: 'Where', customer: 'Customer', services: 'Services', specialist: 'Specialist',
      total: 'Total', deposit: 'Deposit', paid: 'Paid', refunded: 'Refunded', balance_due: 'Balance due on the day', tax_included: 'Of which tax',
      quote_valid_until: 'Quote valid until {when}', declined_because: 'Declined: {reason}',
      cancelled_by: { customer: 'Cancelled by the customer', business: 'Cancelled by you', system: 'Cancelled automatically' },
      payments: 'Payments',
      pay_kind: { deposit: 'Deposit', balance: 'Balance', full: 'Full amount', on_site: 'On site' },
      pay_status: { pending: 'Creating', requires_action: 'Awaiting payment', authorized: 'Authorized', captured: 'Paid', failed: 'Failed', cancelled: 'Cancelled', expired: 'Expired' },
      send_quote: 'Send quote', revise_quote: 'Revise quote', decline: 'Decline request', cancel: 'Cancel event',
      cancel_refund_note: 'Everything the customer paid ({amount}) will be refunded because you are cancelling.',
      collect_balance: 'Record balance received', balance_ok: 'Payment recorded', complete: 'Event done', completed_ok: 'Event completed',
      quote_sent: 'Quote sent to the customer', busy: 'You have an appointment or leave at that time. Choose another specialist or decline the request.',
      price: 'Event price', price_hint: 'Requested services × people: {amount}', duration_hours: 'Duration (hours)',
      prep_min: 'Preparation and travel before (minutes)', prep_hint: 'Also reserved from your time so nothing is booked over it.',
      deposit_percent: 'Percent of total (%)', deposit_fixed: 'Fixed amount', deposit_preview: 'Deposit: {amount}',
      valid_days: 'Quote valid for (days)', quote_note: 'Note to the customer (optional)',
      quote_explainer: 'The customer is notified. When she accepts, your time is held while she pays the deposit, then the booking is confirmed automatically.',
      amount: 'Amount', method: 'Payment method', methods: { cash: 'Cash', pos_terminal: 'Card terminal' }, reference: 'Reference / receipt number',
      s: {
        enabled: 'Accept event requests from the store', default_deposit: 'Default deposit (%)', free_cancellation_days: 'Free cancellation up to (days before)',
        free_cancellation_hint: 'If the customer cancels later, you keep the deposit. The policy saved when the quote is sent applies.',
        quote_validity_days: 'Default quote validity (days)', max_people: 'Maximum people per request', intro_ar: 'Request page intro (Arabic)', intro_en: 'Request page intro (English)',
      },
    },
    sf: {
      title: 'Event bookings', intro: 'Weddings, graduations, group makeup… send us your event details and we will send you a quote.',
      my_requests: 'My requests', sign_in: 'Sign in to send a request and follow your quote.',
      occasion: 'Occasion', date: 'Date', time: 'Start time', time_hint: 'Business local time', location: 'Location', venue: 'Venue address',
      venue_placeholder: 'Venue name, district, city', people: 'Number of people', people_hint: 'Up to {n}', services: 'Services (optional)',
      notes: 'More details', notes_placeholder: 'e.g. bride + 3 companions, hair and makeup', phone: 'Contact number (optional)', phone_hint: 'Used for coordination only.',
      how_it_works: 'After you send the request you receive a quote; the booking is confirmed when you pay the deposit online. Free cancellation up to {days} days before the event.',
      submit: 'Send request',
      status: { requested: 'Awaiting quote', quoted: 'Quote received', pending_payment: 'Awaiting payment', confirmed: 'Confirmed', completed: 'Completed', declined: 'Declined', expired: 'Expired', cancelled: 'Cancelled' },
      status_long: {
        requested: 'We received your request and will send you a quote soon.', quoted: 'Your quote is ready. Pay the deposit to confirm.', pending_payment: 'Checking your deposit payment…',
        confirmed: 'Your event booking is confirmed 🎉', completed: 'Your event is done. Thank you!', declined: 'Sorry, we cannot take this request.', expired: 'This quote has expired. Contact us for a new one.', cancelled: 'This booking was cancelled.',
      },
      quote: 'Quote', until: 'Until {when}', deposit_now: 'Deposit now', balance_on_day: 'Balance on the day',
      valid_until: 'Quote valid until {when}', policy: 'Free cancellation up to {days} days before the event; after that the deposit is not refunded.',
      accept_pay: 'Accept and pay the {amount} deposit', confirmed_note: 'The balance is paid on the day.',
      quote_changed: 'The quote was updated. Please review it before paying.', cancel: 'Cancel request', cancel_reason: 'Reason for cancelling', confirm_cancel: 'Confirm cancellation',
      late_cancel_warning: 'The free cancellation period has passed, so the deposit is not refunded.', back: 'All event requests',
    },
    portfolio: {
      title: 'Portfolio', subtitle: 'Before and after photos of your work, shown in the store through the “Before & after” section.',
      builder_hint: 'To show them in your store, add a “Before & after” section and choose the portfolio as its source in', add: 'Add work', added: 'Work added', deleted: 'Work deleted',
      empty: 'No work yet', empty_hint: 'Add a before and an after photo for each piece of work.', hidden: 'Hidden', hide: 'Hide from the store', show: 'Show in the store',
      single: 'Single photo', untitled: 'Untitled', caption_ar: 'Caption (Arabic)', caption_en: 'Caption (English)', category: 'Category',
      category_hint: 'e.g. Bridal, Evening, Hair. A section can show one category.', delete_title: 'Delete this work?', delete_body: 'It disappears from the store. The photos stay in your image library.',
    },
    ba: {
      pairs: 'Works', before: 'Before', after: 'After', before_optional: 'Before photo (optional)', add_pair: 'Add work (before and after)',
      from_portfolio: 'This section shows the work from your portfolio page (items with a before and an after photo).',
      o_portfolio: 'From “My work”',
    },
    ig: {
      account: 'Instagram account', handle: 'Username', handle_hint: 'Your profile link shows in the store even when the account is not connected.',
      from_social: 'From your social links: @{handle}', not_configured: 'Showing your latest posts needs an official Instagram connection, coming soon. For now the store shows a “Follow us on Instagram” button.',
      sync_error: 'Could not refresh posts from Instagram. Showing the last saved posts.',
      status: { not_connected: 'Not connected', connected: 'Connected', error: 'Connection error' },
    },
  },
};

export const expert = { ar, en };

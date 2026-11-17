/**
 * Business-type workspace rules (LUMA-AUDIT-014, owner decision R5): what a
 * freelancer sees, and the «غير متاح» page for areas her workspace does not have.
 */
const ar = {
  workspace_mode: {
    not_available: {
      title: 'غير متاح لنشاطك',
      hosting: 'تأجير المساحات خاص بالصالونات. يمكنك حجز مساحة عمل من «احجزي مساحة عمل».',
      groups: 'الحصص الجماعية خاصة بالصالونات والأكاديميات. يمكنك بيع حجوزات المناسبات من «المناسبات».',
      payroll: 'الرواتب والحضور والإجازات وملفات الموظفات تظهر عندما تضيفين مساعدة نشطة من «مساعداتي».',
      back: 'العودة إلى اللوحة',
    },
    solo_team_hint: 'تعملين وحدك الآن: الرواتب والحضور والإجازات وملفات الموظفات ستظهر هنا تلقائيًا بعد إضافة مساعدة.',
    own_schedule: 'أنتِ تديرين جدولك بنفسك. التغييرات تُطبَّق على المواعيد المتاحة للحجز فورًا.',
    studio_title: 'الاستوديو',
    studio_hint: 'تعملين من استوديو واحد. عدّلي العنوان وساعات العمل هنا.',
  },
};

const en: typeof ar = {
  workspace_mode: {
    not_available: {
      title: 'Not available for your business',
      hosting: 'Renting out spaces is a salon feature. You can book a workspace from “Book a workspace”.',
      groups: 'Group classes are for salons and academies. You can sell event bookings from “Events”.',
      payroll: 'Payroll, attendance, leave and staff files appear once you add an active assistant in “My assistants”.',
      back: 'Back to the dashboard',
    },
    solo_team_hint: 'You work on your own for now: payroll, attendance, leave and staff files will appear here automatically once you add an assistant.',
    own_schedule: 'You manage your own schedule. Changes apply to your bookable times right away.',
    studio_title: 'Studio',
    studio_hint: 'You work from one studio. Edit its address and opening hours here.',
  },
};

export const workspaceMode = { ar, en };

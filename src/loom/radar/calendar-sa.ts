import type { CalendarKind, DateBasis } from './types';

/**
 * Curated STARTER calendar for Saudi Arabia, November 2026 – November 2027.
 *
 * Every entry names its authority (source_name / source_url) and how its date
 * is known (date_basis). Rules:
 *   - fixed_gregorian: the date is fixed by the named authority every year
 *     (royal order for national days, WHO/UN for international days);
 *   - lunar_estimate: Hijri occasions computed from the Umm al-Qura calendar.
 *     The real date depends on the official moon-sighting announcement, so
 *     they are ALWAYS needs_verification = true;
 *   - approximate: school calendars and seasons whose exact dates were not
 *     taken from an official publication. ALWAYS needs_verification = true.
 * Unverified entries are shown as «يحتاج تحقق» and are never used as a date
 * by the engine until the platform owner verifies them (or an official
 * source import replaces them). This is reference data, not news.
 */
export type StarterEvent = {
  key: string;
  kind: CalendarKind;
  region: string;
  title_ar: string;
  title_en: string;
  starts_on: string;
  ends_on: string;
  date_basis: Extract<DateBasis, 'fixed_gregorian' | 'lunar_estimate' | 'approximate'>;
  needs_verification: boolean;
  source_name: string;
  source_url: string | null;
  topics: string[];
};

const ROYAL = 'Royal order (fixed Gregorian date) — verify on the national platform';
const UMM_AL_QURA = 'Umm al-Qura calendar estimate — final date by the official moon-sighting announcement';
const MOE = 'Ministry of Education academic calendar — dates approximate until the official calendar is imported';

export const SA_STARTER_CALENDAR: StarterEvent[] = [
  { key: 'starter:sa:singles_day:2026', kind: 'commercial', region: 'SA', title_ar: 'موسم تخفيضات ١١/١١', title_en: '11.11 shopping day', starts_on: '2026-11-11', ends_on: '2026-11-11', date_basis: 'fixed_gregorian', needs_verification: false, source_name: 'Retail convention (not an official occasion)', source_url: null, topics: [] },
  { key: 'starter:sa:world_diabetes_day:2026', kind: 'health_awareness', region: 'GLOBAL', title_ar: 'اليوم العالمي للسكري', title_en: 'World Diabetes Day', starts_on: '2026-11-14', ends_on: '2026-11-14', date_basis: 'fixed_gregorian', needs_verification: false, source_name: 'WHO / International Diabetes Federation (14 November every year)', source_url: 'https://www.who.int/campaigns/world-diabetes-day', topics: ['diabetes_day'] },
  { key: 'starter:sa:riyadh_season:2026', kind: 'local_event', region: 'SA:riyadh', title_ar: 'موسم الرياض (تواريخ تقريبية)', title_en: 'Riyadh Season (approximate dates)', starts_on: '2026-11-09', ends_on: '2027-03-31', date_basis: 'approximate', needs_verification: true, source_name: 'General Entertainment Authority announcements — dates not confirmed', source_url: null, topics: [] },
  { key: 'starter:sa:midyear_break:1448', kind: 'school_holiday', region: 'SA', title_ar: 'إجازة منتصف العام الدراسي (تقريبي)', title_en: 'Mid-year school break (approximate)', starts_on: '2027-01-14', ends_on: '2027-01-24', date_basis: 'approximate', needs_verification: true, source_name: MOE, source_url: null, topics: [] },
  { key: 'starter:sa:world_cancer_day:2027', kind: 'health_awareness', region: 'GLOBAL', title_ar: 'اليوم العالمي للسرطان', title_en: 'World Cancer Day', starts_on: '2027-02-04', ends_on: '2027-02-04', date_basis: 'fixed_gregorian', needs_verification: false, source_name: 'Union for International Cancer Control (4 February every year)', source_url: 'https://www.worldcancerday.org', topics: ['world_cancer_day'] },
  { key: 'starter:sa:ramadan:1448', kind: 'religious', region: 'SA', title_ar: 'شهر رمضان ١٤٤٨ (تقديري)', title_en: 'Ramadan 1448 (estimated)', starts_on: '2027-02-08', ends_on: '2027-03-09', date_basis: 'lunar_estimate', needs_verification: true, source_name: UMM_AL_QURA, source_url: null, topics: [] },
  { key: 'starter:sa:founding_day:2027', kind: 'national', region: 'SA', title_ar: 'يوم التأسيس', title_en: 'Saudi Founding Day', starts_on: '2027-02-22', ends_on: '2027-02-22', date_basis: 'fixed_gregorian', needs_verification: false, source_name: `${ROYAL} (22 February)`, source_url: null, topics: [] },
  { key: 'starter:sa:womens_day:2027', kind: 'world_day', region: 'GLOBAL', title_ar: 'اليوم الدولي للمرأة', title_en: 'International Women’s Day', starts_on: '2027-03-08', ends_on: '2027-03-08', date_basis: 'fixed_gregorian', needs_verification: false, source_name: 'United Nations international day (8 March)', source_url: 'https://www.un.org/en/observances/womens-day', topics: [] },
  { key: 'starter:sa:eid_al_fitr:1448', kind: 'religious', region: 'SA', title_ar: 'عيد الفطر ١٤٤٨ (تقديري)', title_en: 'Eid al-Fitr 1448 (estimated)', starts_on: '2027-03-10', ends_on: '2027-03-13', date_basis: 'lunar_estimate', needs_verification: true, source_name: UMM_AL_QURA, source_url: null, topics: [] },
  { key: 'starter:sa:flag_day:2027', kind: 'national', region: 'SA', title_ar: 'يوم العلم', title_en: 'Saudi Flag Day', starts_on: '2027-03-11', ends_on: '2027-03-11', date_basis: 'fixed_gregorian', needs_verification: false, source_name: `${ROYAL} (11 March)`, source_url: null, topics: [] },
  { key: 'starter:sa:world_health_day:2027', kind: 'health_awareness', region: 'GLOBAL', title_ar: 'يوم الصحة العالمي', title_en: 'World Health Day', starts_on: '2027-04-07', ends_on: '2027-04-07', date_basis: 'fixed_gregorian', needs_verification: false, source_name: 'World Health Organization (7 April every year)', source_url: 'https://www.who.int/campaigns/world-health-day', topics: ['world_health_day'] },
  { key: 'starter:sa:eid_al_adha:1448', kind: 'religious', region: 'SA', title_ar: 'يوم عرفة وعيد الأضحى ١٤٤٨ (تقديري)', title_en: 'Day of Arafah and Eid al-Adha 1448 (estimated)', starts_on: '2027-05-15', ends_on: '2027-05-19', date_basis: 'lunar_estimate', needs_verification: true, source_name: UMM_AL_QURA, source_url: null, topics: [] },
  { key: 'starter:sa:hijri_new_year:1449', kind: 'religious', region: 'SA', title_ar: 'رأس السنة الهجرية ١٤٤٩ (تقديري)', title_en: 'Hijri New Year 1449 (estimated)', starts_on: '2027-06-06', ends_on: '2027-06-06', date_basis: 'lunar_estimate', needs_verification: true, source_name: UMM_AL_QURA, source_url: null, topics: [] },
  { key: 'starter:sa:summer_break:1448', kind: 'school_holiday', region: 'SA', title_ar: 'الإجازة الصيفية للمدارس (تقريبي)', title_en: 'School summer holiday (approximate)', starts_on: '2027-06-18', ends_on: '2027-08-21', date_basis: 'approximate', needs_verification: true, source_name: MOE, source_url: null, topics: [] },
  { key: 'starter:sa:back_to_school:1449', kind: 'school_holiday', region: 'SA', title_ar: 'العودة إلى المدارس (تقريبي)', title_en: 'Back to school (approximate)', starts_on: '2027-08-22', ends_on: '2027-08-22', date_basis: 'approximate', needs_verification: true, source_name: MOE, source_url: null, topics: [] },
  { key: 'starter:sa:national_day:2027', kind: 'national', region: 'SA', title_ar: 'اليوم الوطني السعودي', title_en: 'Saudi National Day', starts_on: '2027-09-23', ends_on: '2027-09-23', date_basis: 'fixed_gregorian', needs_verification: false, source_name: `${ROYAL} (23 September)`, source_url: null, topics: [] },
  { key: 'starter:sa:breast_cancer_month:2027', kind: 'health_awareness', region: 'GLOBAL', title_ar: 'شهر التوعية بسرطان الثدي', title_en: 'Breast Cancer Awareness Month', starts_on: '2027-10-01', ends_on: '2027-10-31', date_basis: 'fixed_gregorian', needs_verification: false, source_name: 'WHO / international awareness month (October)', source_url: 'https://www.who.int/news-room/fact-sheets/detail/breast-cancer', topics: ['breast_cancer_awareness'] },
  { key: 'starter:sa:mental_health_day:2027', kind: 'health_awareness', region: 'GLOBAL', title_ar: 'اليوم العالمي للصحة النفسية', title_en: 'World Mental Health Day', starts_on: '2027-10-10', ends_on: '2027-10-10', date_basis: 'fixed_gregorian', needs_verification: false, source_name: 'World Health Organization (10 October every year)', source_url: 'https://www.who.int/campaigns/world-mental-health-day', topics: ['mental_health_day'] },
];

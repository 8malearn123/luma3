import { makeBlock, DEFAULT_LAYOUT, type PageBlock, type SiteLayout } from '@/shared/builder/blocks';
import { NEUTRAL_BRAND, paletteFromSeeds, zColors, type Brand, type FontKey } from '@/shared/builder/theme';
import type { OnboardingAnswers } from '@/shared/onboarding';

/**
 * Deterministic initial storefront from onboarding answers. Pure function so it
 * is fully testable and works with AI disconnected. It never invents services,
 * prices, credentials or reviews: catalog blocks only reference what exists,
 * and the reviews block renders real, visit-linked reviews only.
 */

export type DefaultPageKind = 'home' | 'about' | 'services' | 'products' | 'team' | 'contact' | 'faq' | 'booking_policy' | 'privacy' | 'returns';

export const DEFAULT_PAGES: Array<{ kind: DefaultPageKind; slug: string; title_ar: string; title_en: string; nav: boolean; footer: boolean; sort: number }> = [
  { kind: 'home', slug: 'home', title_ar: 'الرئيسية', title_en: 'Home', nav: false, footer: false, sort: 0 },
  { kind: 'services', slug: 'services', title_ar: 'الخدمات', title_en: 'Services', nav: true, footer: false, sort: 1 },
  { kind: 'team', slug: 'team', title_ar: 'الفريق', title_en: 'Team', nav: true, footer: false, sort: 2 },
  { kind: 'products', slug: 'products', title_ar: 'المنتجات', title_en: 'Products', nav: true, footer: false, sort: 3 },
  { kind: 'about', slug: 'about', title_ar: 'من نحن', title_en: 'About', nav: true, footer: true, sort: 4 },
  { kind: 'contact', slug: 'contact', title_ar: 'تواصلي معنا', title_en: 'Contact', nav: true, footer: true, sort: 5 },
  { kind: 'faq', slug: 'faq', title_ar: 'الأسئلة الشائعة', title_en: 'FAQ', nav: false, footer: true, sort: 6 },
  { kind: 'booking_policy', slug: 'booking-policy', title_ar: 'سياسة الحجز والإلغاء', title_en: 'Booking & cancellation policy', nav: false, footer: true, sort: 7 },
  { kind: 'privacy', slug: 'privacy', title_ar: 'الخصوصية', title_en: 'Privacy', nav: false, footer: true, sort: 8 },
  { kind: 'returns', slug: 'returns', title_ar: 'الاستبدال والاسترجاع', title_en: 'Returns', nav: false, footer: true, sort: 9 },
];

const STYLE_SEEDS: Record<string, string> = {
  soft_minimal: '#B88F84', classic_luxury: '#6B4E3D', modern_bold: '#2E4A62', natural_warm: '#6F7F5E',
};

export function brandFromAnswers(a: OnboardingAnswers, current: Brand = NEUTRAL_BRAND): Brand {
  const traits = new Set(a[3]?.traits ?? []);
  const ref = a[3]?.reference_style;
  const mood: 'soft' | 'bold' | 'classic' =
    traits.has('bold') || traits.has('playful') || ref === 'modern_bold' ? 'bold'
      : traits.has('warm') || traits.has('natural') || ref === 'soft_minimal' || ref === 'natural_warm' ? 'soft' : 'classic';

  let fonts: { heading: FontKey; body: FontKey } = current.fonts;
  if (a[4]?.fonts) fonts = a[4].fonts;
  else if (traits.has('luxurious') || traits.has('elegant') || ref === 'classic_luxury') fonts = { heading: 'amiri', body: 'noto_naskh' };
  else if (traits.has('modern') || traits.has('minimal') || ref === 'soft_minimal') fonts = { heading: 'readex_pro', body: 'ibm_plex_arabic' };
  else if (traits.has('warm') || traits.has('natural') || ref === 'natural_warm') fonts = { heading: 'markazi', body: 'tajawal' };
  else if (traits.has('playful') || traits.has('bold') || ref === 'modern_bold') fonts = { heading: 'reem_kufi', body: 'cairo' };

  let colors = current.colors;
  const accepted = a[4]?.accepted_palette ? zColors.safeParse({ ...current.colors, ...a[4].accepted_palette }) : null;
  if (accepted?.success) colors = accepted.data;
  else if (a[4]?.existing_colors?.length) colors = paletteFromSeeds(a[4].existing_colors, mood, a[4]?.excluded_colors);
  else if (ref && STYLE_SEEDS[ref]) colors = paletteFromSeeds([STYLE_SEEDS[ref]!], mood, a[4]?.excluded_colors);

  return {
    ...current,
    colors,
    fonts,
    radius: traits.has('playful') ? 'lg' : traits.has('elegant') || traits.has('luxurious') ? 'sm' : traits.has('minimal') ? 'md' : current.radius,
    button_style: traits.has('luxurious') ? 'outline' : traits.has('minimal') ? 'soft' : 'solid',
    card_style: traits.has('minimal') ? 'flat' : traits.has('luxurious') ? 'bordered' : 'elevated',
    density: traits.has('luxurious') || traits.has('elegant') ? 'spacious' : current.density,
    logo_asset_id: a[2]?.logo_asset_id ?? current.logo_asset_id,
    wordmark_text: a[2]?.wordmark_text || a[1]?.name || current.wordmark_text,
    tagline_ar: a[7]?.tagline ?? current.tagline_ar,
  };
}

const t = (ar: string, en: string) => ({ ar, en });

export function pagesFromAnswers(a: OnboardingAnswers, ctx: { pageIds: Partial<Record<DefaultPageKind, string>>; productsEnabled: boolean }): Partial<Record<DefaultPageKind, PageBlock[]>> {
  const p7 = a[7] ?? {};
  const priorities = (a[6]?.priorities?.length ? a[6].priorities : ['booking', 'portfolio', 'offers', 'reviews', 'team', 'products'])
    .filter((x) => x !== 'products' || ctx.productsEnabled);
  const hasSocial = !!p7.social && Object.values(p7.social).some(Boolean);
  const hasMap = typeof p7.latitude === 'number' && typeof p7.longitude === 'number';

  const hero = makeBlock('hero', {
    props: {
      title: t(a[1]?.name ?? '', a[1]?.name ?? ''),
      subtitle: p7.tagline ? { ar: p7.tagline } : undefined,
      image_asset_id: p7.cover_asset_id ?? null, overlay: 0.35, align: 'center', height: 'lg',
      cta_label: t('احجزي موعدك', 'Book an appointment'),
    },
    action: { type: 'start_booking' },
  });

  const section: Record<string, () => PageBlock> = {
    booking: () => makeBlock('service_list', { props: { title: t('خدماتنا', 'Our services'), display: 'cards', category_id: null, service_ids: [], show_prices: true, show_durations: true, columns: 2, group_by_category: true } }),
    portfolio: () => makeBlock('gallery', { props: { title: t('من أعمالنا', 'Our work'), layout: 'grid', columns: 3, items: [], lightbox: true } }),
    products: () => makeBlock('product_grid', { props: { title: t('منتجاتنا', 'Shop'), display: 'grid', category_id: null, product_ids: [], columns: 3, show_prices: true } }),
    offers: () => makeBlock('offers', { props: { title: t('العروض والباقات', 'Offers & packages'), package_ids: [], display: 'cards' } }),
    reviews: () => makeBlock('reviews', { props: { title: t('تجارب عميلاتنا', 'What clients say'), min_rating: 4, limit: 6, show_staff: true } }),
    team: () => makeBlock('team', { props: { title: t('فريقنا', 'Our team'), staff_ids: [], display: 'cards', show_bios: true } }),
  };

  const intro = p7.intro
    ? makeBlock('intro', { props: { title: t('من نحن', 'About us'), body: { ar: [{ t: 'p', c: [{ text: p7.intro }] }] }, image_asset_id: null, layout: 'text_only' } })
    : null;

  const home: PageBlock[] = [hero, ...priorities.map((k) => section[k]!()), ...(intro ? [intro] : []), makeBlock('hours', { props: { title: t('ساعات العمل', 'Opening hours'), branch_id: null } })];
  if (hasMap) home.push(makeBlock('map', { props: { title: t('موقعنا', 'Find us'), branch_id: null, zoom: 15 } }));
  home.push(makeBlock('contact', { props: { title: t('تواصلي معنا', 'Contact us'), show_phone: true, show_email: true, show_whatsapp: true, show_address: true } }));
  if (hasSocial) home.push(makeBlock('social', { props: { style: 'icons' } }));

  const pages: Partial<Record<DefaultPageKind, PageBlock[]>> = {
    home,
    services: [makeBlock('categories', { props: { kind: 'service', display: 'chips' } }), makeBlock('service_list', { props: { display: 'list', category_id: null, service_ids: [], show_prices: true, show_durations: true, columns: 1, group_by_category: true } })],
    team: [makeBlock('team', { props: { staff_ids: [], display: 'cards', show_bios: true } })],
    about: [
      ...(intro ? [makeBlock('intro', { props: { title: t('قصتنا', 'Our story'), body: { ar: [{ t: 'p', c: [{ text: p7.intro! }] }] }, image_asset_id: p7.cover_asset_id ?? null, layout: 'image_start' } })] : []),
      makeBlock('hours', { props: { branch_id: null } }),
    ],
    contact: [
      makeBlock('contact', { props: { show_phone: true, show_email: true, show_whatsapp: true, show_address: true } }),
      ...(hasMap ? [makeBlock('map', { props: { branch_id: null, zoom: 15 } })] : []),
      makeBlock('hours', { props: { branch_id: null } }),
      ...(hasSocial ? [makeBlock('social', { props: { style: 'buttons' } })] : []),
    ],
    faq: [makeBlock('faq', { props: { items: [] } })],
    booking_policy: [],
    privacy: [],
    returns: [],
  };
  if (ctx.productsEnabled) pages.products = [makeBlock('categories', { props: { kind: 'product', display: 'chips' } }), makeBlock('product_grid', { props: { display: 'grid', category_id: null, product_ids: [], columns: 3, show_prices: true } })];
  return pages;
}

export function layoutFromAnswers(a: OnboardingAnswers): SiteLayout {
  const traits = new Set(a[3]?.traits ?? []);
  return {
    ...DEFAULT_LAYOUT,
    nav_style: traits.has('playful') || traits.has('modern') ? 'pill' : 'simple',
  };
}

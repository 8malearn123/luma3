import type { PageBlock, SiteLayout } from './blocks';
import type { Brand } from './theme';

/**
 * Public storefront read model (isomorphic types). Built server-side from the
 * published snapshot (or the draft for previews/the builder canvas) plus LIVE
 * catalog data with allowlisted fields only. Never contains costs, commissions,
 * private notes or customer contact data.
 */

export type PageKind = 'home' | 'about' | 'services' | 'products' | 'team' | 'contact' | 'faq' | 'privacy' | 'returns' | 'booking_policy' | 'custom';

export type SnapshotPage = {
  id: string;
  kind: PageKind;
  slug: string;
  title_ar: string | null;
  title_en: string | null;
  show_in_nav: boolean;
  show_in_footer: boolean;
  sort: number;
  blocks: PageBlock[];
};

/** Immutable document stored in site_versions.snapshot. */
export type SiteSnapshot = {
  schema_version: 1;
  brand: Brand;
  layout: SiteLayout;
  pages: SnapshotPage[];
};

export type PublicService = {
  id: string; name_ar: string | null; name_en: string | null; description_ar: string | null; description_en: string | null;
  price_minor: number; price_display: 'fixed' | 'starting_from'; duration_min: number; image_asset_id: string | null;
  category_id: string | null; staff_ids: string[]; bookable: boolean;
};
export type PublicStaff = {
  id: string; display_name: string; display_name_en: string | null; title_ar: string | null; title_en: string | null;
  bio_ar: string | null; bio_en: string | null; photo_asset_id: string | null; service_ids: string[];
};
export type PublicVariant = { id: string; name_ar: string | null; name_en: string | null; price_minor: number; in_stock: boolean; is_default: boolean };
export type PublicProduct = {
  id: string; name_ar: string | null; name_en: string | null; description_ar: string | null; description_en: string | null;
  category_id: string | null; price_minor: number | null; default_variant_id: string | null; image_asset_ids: string[];
  in_stock: boolean; max_per_order: number; variants: PublicVariant[];
};
export type PublicCategory = { id: string; kind: 'service' | 'product'; name_ar: string | null; name_en: string | null; slug: string };
export type PublicPackage = { id: string; name_ar: string | null; name_en: string | null; description_ar: string | null; description_en: string | null; price_minor: number; service_ids: string[] };
export type PublicReview = { id: string; rating: number; comment: string | null; author: string; staff_id: string | null; created_at: string; business_reply: string | null };
export type PublicBranch = {
  id: string; name: string; city: string | null; address: string | null; latitude: number | null; longitude: number | null;
  phone: string | null; is_primary: boolean; timezone: string; hours: Array<{ weekday: number; opens: string; closes: string }>;
};
export type PublicAsset = { width: number | null; height: number | null; alt_ar: string | null; alt_en: string | null };

export type StorefrontMode = 'published' | 'preview' | 'canvas';

export type StorefrontData = {
  mode: StorefrontMode;
  /** Preview token (preview mode only) so internal links stay inside the preview. */
  previewToken?: string;
  tenant: { slug: string; name: string; currency: string; timezone: string; default_locale: 'ar' | 'en'; business_type: string };
  brand: Brand;
  layout: SiteLayout;
  /** Effective "Powered by LUMA" visibility after plan policy. */
  powered_by: boolean;
  pages: SnapshotPage[];
  version: { id: string; number: number; published_at: string } | null;
  catalog: {
    services: PublicService[];
    staff: PublicStaff[];
    products: PublicProduct[];
    categories: PublicCategory[];
    packages: PublicPackage[];
    reviews: PublicReview[];
  };
  branches: PublicBranch[];
  contact: { phone: string | null; email: string | null; whatsapp: string | null; social: Record<string, string> };
  assets: Record<string, PublicAsset>;
  policy: {
    text_ar: string | null; text_en: string | null; free_cancellation_hours: number; late_cancellation_fee_bp: number;
    deposit_mode: 'none' | 'percent' | 'fixed'; deposit_percent_bp: number; deposit_fixed_minor: number; allow_pay_on_site: boolean;
  };
  features: { products: boolean };
};

export const SOCIAL_KEYS = ['instagram', 'tiktok', 'snapchat', 'x', 'facebook', 'youtube', 'website'] as const;

/** Route for a page kind on the public storefront (relative to /s/{slug}). */
export function pagePath(p: Pick<SnapshotPage, 'kind' | 'slug'>): string {
  switch (p.kind) {
    case 'home': return '';
    case 'about': return '/about';
    case 'services': return '/services';
    case 'products': return '/products';
    case 'team': return '/team';
    case 'contact': return '/contact';
    default: return `/pages/${p.slug}`;
  }
}

/** Reserved custom-page slugs (they collide with fixed storefront routes or default pages). */
export const RESERVED_PAGE_SLUGS = new Set(['home', 'services', 'products', 'team', 'about', 'contact', 'policies', 'pages', 'booking', 'cart', 'checkout', 'account', 'faq', 'privacy', 'returns', 'booking-policy', 'preview', 'api']);

import type { PageBlock, SiteLayout } from '@/shared/builder/blocks';
import type { PageKind, StorefrontData } from '@/shared/builder/storefront';
import type { Brand, ContrastWarning } from '@/shared/builder/theme';

export type Issue = { pageId: string | null; blockId: string | null; path: string; code: string; message: string };
export type RefWarning = { pageId: string | null; blockId: string | null; kind: string; targetId: string; code: string };

export type BuilderPage = {
  id: string; kind: PageKind; slug: string; title_ar: string | null; title_en: string | null; show_in_nav: boolean; show_in_footer: boolean;
  sort: number; status: 'active' | 'archived'; version: number; updated_at: string; blocks: PageBlock[];
};

type Named = { id: string; name_ar: string | null; name_en: string | null };
export type CatalogRefs = {
  services: Array<Named & { is_active: boolean; is_visible: boolean; archived: boolean; category_id: string | null }>;
  products: Array<Named & { status: string; is_visible: boolean; archived: boolean; category_id: string | null }>;
  staff: Array<{ id: string; display_name: string; display_name_en: string | null; is_active: boolean; is_public: boolean; archived: boolean }>;
  categories: Array<Named & { kind: 'service' | 'product'; is_visible: boolean; archived: boolean }>;
  packages: Array<Named & { is_active: boolean; is_visible: boolean; archived: boolean }>;
  branches: Array<{ id: string; name: string; status: string; is_primary: boolean }>;
  assets: Array<{ id: string; purpose: string; width: number | null; height: number | null; alt_ar: string | null; alt_en: string | null; created_at: string }>;
};

export type AiState =
  | { state: 'connected'; provider: string; model: string; verified_at: string | null }
  | { state: 'disconnected'; reason: string }
  | { state: 'misconfigured'; reason: string }
  | { state: 'plan_disabled' };

export type BuilderState = {
  brand: Brand & { version: number };
  brand_version: number;
  layout: SiteLayout;
  layout_version: number;
  pages: BuilderPage[];
  validation: { issues: Issue[]; warnings: RefWarning[] };
  contrast_warnings: ContrastWarning[];
  readiness: { ready: boolean; items: Array<{ key: string; ok: boolean; action_path: string }> };
  ai_status: AiState;
  policy: { can_remove_powered_by: boolean; custom_pages_limit: number | null; customization_ai: boolean; products: boolean };
  published: { tenant_status: string; version_id: string | null; version_number: number | null; published_at: string | null };
  catalog: CatalogRefs;
  storefront: StorefrontData;
};

export type Doc = { brand: Brand; layout: SiteLayout; blocks: Record<string, PageBlock[]> };

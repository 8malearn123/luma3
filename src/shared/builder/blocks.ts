import { z } from 'zod';

/**
 * Storefront block registry (shared by server validation, the builder editor,
 * the renderer and the customization assistant).
 *
 * Safety model:
 *  - Blocks are configuration, never code. No raw HTML/JS is accepted; rich text
 *    is a restricted structure sanitised again on the server.
 *  - URLs are allowlisted by protocol (https, tel, mailto, WhatsApp).
 *  - Catalog references are IDs (prices are read from the catalog at render time).
 *  - Each type has a schemaVersion and a migration path.
 */

export const zLocalized = z.object({ ar: z.string().max(2000).optional(), en: z.string().max(2000).optional() }).strict();
export type Localized = z.infer<typeof zLocalized>;
const zShort = z.object({ ar: z.string().max(160).optional(), en: z.string().max(160).optional() }).strict();
const zId = z.string().uuid();
const zAsset = z.string().uuid().nullable();

/** Allowed external URL protocols; javascript:, data:, file:, etc. are rejected. */
export function isSafeExternalUrl(raw: string): boolean {
  if (raw.length > 2000) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol === 'https:') return !!u.hostname && !u.username && !u.password;
  if (u.protocol === 'mailto:' || u.protocol === 'tel:') return /^[^<>"'\s]+$/.test(raw);
  return false;
}
export const zSafeUrl = z.string().refine(isSafeExternalUrl, 'Only https, tel: and mailto: links are allowed');

export const ACTION_TYPES = ['start_booking', 'service', 'product', 'category', 'staff', 'page', 'section', 'external'] as const;
export const zAction = z.discriminatedUnion('type', [
  z.object({ type: z.literal('start_booking'), targetId: zId.optional() }).strict(), // optional preselected service
  z.object({ type: z.literal('service'), targetId: zId }).strict(),
  z.object({ type: z.literal('product'), targetId: zId }).strict(),
  z.object({ type: z.literal('category'), targetId: zId }).strict(),
  z.object({ type: z.literal('staff'), targetId: zId }).strict(),
  z.object({ type: z.literal('page'), targetId: zId }).strict(),
  z.object({ type: z.literal('section'), targetId: z.string().regex(/^[a-zA-Z0-9_-]{6,40}$/) }).strict(),
  z.object({ type: z.literal('external'), url: zSafeUrl }).strict(),
]);
export type BlockAction = z.infer<typeof zAction>;

// Restricted rich text: paragraphs/headings/lists of inline runs.
const zInline = z.object({
  text: z.string().max(2000),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  href: zSafeUrl.optional(),
}).strict();
const zRichNode = z.discriminatedUnion('t', [
  z.object({ t: z.literal('p'), c: z.array(zInline).max(50) }).strict(),
  z.object({ t: z.literal('h2'), c: z.array(zInline).max(10) }).strict(),
  z.object({ t: z.literal('h3'), c: z.array(zInline).max(10) }).strict(),
  z.object({ t: z.literal('ul'), items: z.array(z.array(zInline).max(20)).max(30) }).strict(),
  z.object({ t: z.literal('ol'), items: z.array(z.array(zInline).max(20)).max(30) }).strict(),
]);
export const zRich = z.object({ ar: z.array(zRichNode).max(60).optional(), en: z.array(zRichNode).max(60).optional() }).strict();
export type RichText = z.infer<typeof zRich>;

const align = z.enum(['start', 'center', 'end']).default('start');
const background = z.enum(['none', 'surface', 'primary', 'secondary', 'accent', 'image']).default('none');
/** Crop focus for images shown with a fixed aspect ratio (CSS object-position). */
export const FOCAL_POINTS = ['center', 'top', 'bottom', 'start', 'end'] as const;
const focal = z.enum(FOCAL_POINTS).default('center');

// ── Per-type prop schemas ───────────────────────────────────────────────────
const P = {
  hero: z.object({
    title: zShort, subtitle: zShort.optional(), image_asset_id: zAsset.default(null), overlay: z.number().min(0).max(0.8).default(0.35),
    align, height: z.enum(['sm', 'md', 'lg']).default('md'), cta_label: zShort.optional(), focal,
  }).strict(),
  image_ad: z.object({ image_asset_id: zAsset, alt: zShort.optional(), caption: zShort.optional(), aspect: z.enum(['16:9', '3:1', '4:3', '1:1']).default('3:1'), focal }).strict(),
  image: z.object({ image_asset_id: zAsset, alt: zShort.optional(), aspect: z.enum(['16:9', '4:3', '1:1', '3:4', 'auto']).default('auto'), rounded: z.boolean().default(true), focal }).strict(),
  text: z.object({ content: zRich, align, background }).strict(),
  cta: z.object({ label: zShort, style: z.enum(['primary', 'secondary', 'outline']).default('primary'), align: align.default('center'), full_width: z.boolean().default(false) }).strict(),
  service_list: z.object({
    title: zShort.optional(), display: z.enum(['list', 'cards']).default('cards'), category_id: zId.nullable().default(null),
    service_ids: z.array(zId).max(50).default([]), show_prices: z.boolean().default(true), show_durations: z.boolean().default(true),
    columns: z.number().int().min(1).max(4).default(2), group_by_category: z.boolean().default(false),
  }).strict(),
  service_feature: z.object({ service_id: zId, layout: z.enum(['image_start', 'image_end', 'stacked']).default('image_start'), show_price: z.boolean().default(true) }).strict(),
  categories: z.object({ title: zShort.optional(), kind: z.enum(['service', 'product']).default('service'), display: z.enum(['chips', 'tiles']).default('chips') }).strict(),
  product_grid: z.object({
    title: zShort.optional(), display: z.enum(['grid', 'list']).default('grid'), category_id: zId.nullable().default(null),
    product_ids: z.array(zId).max(50).default([]), columns: z.number().int().min(1).max(4).default(3), show_prices: z.boolean().default(true),
  }).strict(),
  product_feature: z.object({ product_id: zId, layout: z.enum(['image_start', 'image_end', 'stacked']).default('image_start') }).strict(),
  team: z.object({ title: zShort.optional(), staff_ids: z.array(zId).max(50).default([]), display: z.enum(['cards', 'avatars']).default('cards'), show_bios: z.boolean().default(true) }).strict(),
  gallery: z.object({
    title: zShort.optional(), layout: z.enum(['grid', 'masonry', 'carousel']).default('grid'), columns: z.number().int().min(2).max(5).default(3),
    items: z.array(z.object({ image_asset_id: zId, alt: zShort.optional(), caption: zShort.optional() }).strict()).max(60).default([]),
    lightbox: z.boolean().default(true),
  }).strict(),
  offers: z.object({ title: zShort.optional(), package_ids: z.array(zId).max(20).default([]), display: z.enum(['cards', 'list']).default('cards') }).strict(),
  reviews: z.object({ title: zShort.optional(), min_rating: z.number().int().min(1).max(5).default(4), limit: z.number().int().min(1).max(20).default(6), show_staff: z.boolean().default(true) }).strict(),
  intro: z.object({ title: zShort.optional(), body: zRich, image_asset_id: zAsset.default(null), layout: z.enum(['image_start', 'image_end', 'text_only']).default('image_start') }).strict(),
  map: z.object({ title: zShort.optional(), branch_id: zId.nullable().default(null), zoom: z.number().int().min(10).max(18).default(15) }).strict(),
  hours: z.object({ title: zShort.optional(), branch_id: zId.nullable().default(null) }).strict(),
  contact: z.object({ title: zShort.optional(), show_phone: z.boolean().default(true), show_email: z.boolean().default(true), show_whatsapp: z.boolean().default(true), show_address: z.boolean().default(true) }).strict(),
  social: z.object({ title: zShort.optional(), style: z.enum(['icons', 'buttons']).default('icons') }).strict(),
  faq: z.object({ title: zShort.optional(), items: z.array(z.object({ q: zShort, a: zLocalized }).strict()).max(40).default([]) }).strict(),
  policies: z.object({ title: zShort.optional(), page_ids: z.array(zId).max(10).default([]) }).strict(),
  page_link: z.object({ page_id: zId, label: zShort.optional(), description: zShort.optional(), image_asset_id: zAsset.default(null) }).strict(),
  welcome: z.object({ message: zShort, style: z.enum(['banner', 'card']).default('banner'), dismissible: z.boolean().default(true) }).strict(),
  spacer: z.object({ size: z.enum(['sm', 'md', 'lg']).default('md'), divider: z.boolean().default(false) }).strict(),
  columns: z.object({ count: z.number().int().min(2).max(3).default(2), gap: z.enum(['sm', 'md', 'lg']).default('md'), stack_on_mobile: z.boolean().default(true) }).strict(),
} as const;

export type BlockType = keyof typeof P;
export const BLOCK_TYPES = Object.keys(P) as BlockType[];

export type BlockDef = {
  type: BlockType;
  schemaVersion: number;
  category: 'layout' | 'media' | 'content' | 'catalog' | 'commerce' | 'people' | 'trust' | 'info';
  label: { ar: string; en: string };
  icon: string; // lucide icon name
  props: z.ZodTypeAny;
  /** Where the block may be placed. */
  placement: Array<'page' | 'columns'>;
  /** Max per page (prevents unrenderable or abusive trees). */
  maxPerPage: number;
  /** Does the block accept an action (click target)? */
  actions: boolean;
  /** Plan feature that must be enabled for the block to render. */
  feature?: string;
  migrate?: (props: Record<string, unknown>, fromVersion: number) => Record<string, unknown>;
  defaults: () => Record<string, unknown>;
};

const def = (d: Omit<BlockDef, 'defaults'> & { defaults?: () => Record<string, unknown> }): BlockDef => ({
  defaults: () => (d.props as z.ZodObject<z.ZodRawShape>).parse({}) as Record<string, unknown>,
  ...d,
});

export const BLOCKS: Record<BlockType, BlockDef> = {
  hero: def({ type: 'hero', schemaVersion: 1, category: 'media', label: { ar: 'واجهة رئيسية', en: 'Hero banner' }, icon: 'PanelTop', props: P.hero, placement: ['page'], maxPerPage: 2, actions: true,
    defaults: () => ({ title: { ar: 'مرحباً بكِ', en: 'Welcome' }, image_asset_id: null, overlay: 0.35, align: 'center', height: 'md', cta_label: { ar: 'احجزي الآن', en: 'Book now' } }) }),
  image_ad: def({ type: 'image_ad', schemaVersion: 1, category: 'media', label: { ar: 'صورة إعلانية', en: 'Image advertisement' }, icon: 'Megaphone', props: P.image_ad, placement: ['page', 'columns'], maxPerPage: 10, actions: true,
    defaults: () => ({ image_asset_id: null, aspect: '3:1' }) }),
  image: def({ type: 'image', schemaVersion: 1, category: 'media', label: { ar: 'صورة قابلة للنقر', en: 'Clickable image' }, icon: 'Image', props: P.image, placement: ['page', 'columns'], maxPerPage: 30, actions: true,
    defaults: () => ({ image_asset_id: null, aspect: 'auto', rounded: true }) }),
  text: def({ type: 'text', schemaVersion: 1, category: 'content', label: { ar: 'نص', en: 'Text' }, icon: 'Type', props: P.text, placement: ['page', 'columns'], maxPerPage: 30, actions: false,
    defaults: () => ({ content: { ar: [{ t: 'p', c: [{ text: 'اكتبي هنا…' }] }], en: [{ t: 'p', c: [{ text: 'Write here…' }] }] }, align: 'start', background: 'none' }) }),
  cta: def({ type: 'cta', schemaVersion: 1, category: 'content', label: { ar: 'زر دعوة', en: 'Call-to-action button' }, icon: 'MousePointerClick', props: P.cta, placement: ['page', 'columns'], maxPerPage: 20, actions: true,
    defaults: () => ({ label: { ar: 'احجزي موعدك', en: 'Book an appointment' }, style: 'primary', align: 'center', full_width: false }) }),
  service_list: def({ type: 'service_list', schemaVersion: 1, category: 'catalog', label: { ar: 'قائمة الخدمات', en: 'Service list' }, icon: 'ListChecks', props: P.service_list, placement: ['page'], maxPerPage: 6, actions: false }),
  service_feature: def({ type: 'service_feature', schemaVersion: 1, category: 'catalog', label: { ar: 'خدمة مميزة', en: 'Featured service' }, icon: 'Sparkles', props: P.service_feature, placement: ['page', 'columns'], maxPerPage: 12, actions: false,
    defaults: () => ({ layout: 'image_start', show_price: true }) }),
  categories: def({ type: 'categories', schemaVersion: 1, category: 'catalog', label: { ar: 'التصنيفات', en: 'Categories' }, icon: 'Tags', props: P.categories, placement: ['page'], maxPerPage: 4, actions: false }),
  product_grid: def({ type: 'product_grid', schemaVersion: 1, category: 'commerce', label: { ar: 'شبكة المنتجات', en: 'Product grid' }, icon: 'LayoutGrid', props: P.product_grid, placement: ['page'], maxPerPage: 6, actions: false, feature: 'feature.products' }),
  product_feature: def({ type: 'product_feature', schemaVersion: 1, category: 'commerce', label: { ar: 'منتج مميز', en: 'Featured product' }, icon: 'ShoppingBag', props: P.product_feature, placement: ['page', 'columns'], maxPerPage: 12, actions: false, feature: 'feature.products',
    defaults: () => ({ layout: 'image_start' }) }),
  team: def({ type: 'team', schemaVersion: 1, category: 'people', label: { ar: 'الفريق', en: 'Team' }, icon: 'Users', props: P.team, placement: ['page'], maxPerPage: 3, actions: false }),
  gallery: def({ type: 'gallery', schemaVersion: 1, category: 'media', label: { ar: 'معرض الأعمال', en: 'Portfolio gallery' }, icon: 'GalleryHorizontal', props: P.gallery, placement: ['page'], maxPerPage: 6, actions: false }),
  offers: def({ type: 'offers', schemaVersion: 1, category: 'catalog', label: { ar: 'العروض والباقات', en: 'Offers & packages' }, icon: 'BadgePercent', props: P.offers, placement: ['page'], maxPerPage: 4, actions: false }),
  reviews: def({ type: 'reviews', schemaVersion: 1, category: 'trust', label: { ar: 'آراء العميلات', en: 'Reviews' }, icon: 'Star', props: P.reviews, placement: ['page'], maxPerPage: 2, actions: false }),
  intro: def({ type: 'intro', schemaVersion: 1, category: 'content', label: { ar: 'نبذة تعريفية', en: 'Introduction' }, icon: 'BookOpenText', props: P.intro, placement: ['page'], maxPerPage: 4, actions: true,
    defaults: () => ({ title: { ar: 'من نحن', en: 'About us' }, body: { ar: [{ t: 'p', c: [{ text: '' }] }] }, image_asset_id: null, layout: 'image_start' }) }),
  map: def({ type: 'map', schemaVersion: 1, category: 'info', label: { ar: 'الموقع على الخريطة', en: 'Map & location' }, icon: 'MapPin', props: P.map, placement: ['page', 'columns'], maxPerPage: 2, actions: false }),
  hours: def({ type: 'hours', schemaVersion: 1, category: 'info', label: { ar: 'ساعات العمل', en: 'Opening hours' }, icon: 'Clock', props: P.hours, placement: ['page', 'columns'], maxPerPage: 2, actions: false }),
  contact: def({ type: 'contact', schemaVersion: 1, category: 'info', label: { ar: 'التواصل', en: 'Contact' }, icon: 'Phone', props: P.contact, placement: ['page', 'columns'], maxPerPage: 2, actions: false }),
  social: def({ type: 'social', schemaVersion: 1, category: 'info', label: { ar: 'روابط التواصل الاجتماعي', en: 'Social links' }, icon: 'Share2', props: P.social, placement: ['page', 'columns'], maxPerPage: 2, actions: false }),
  faq: def({ type: 'faq', schemaVersion: 1, category: 'content', label: { ar: 'الأسئلة الشائعة', en: 'FAQ' }, icon: 'CircleHelp', props: P.faq, placement: ['page'], maxPerPage: 3, actions: false }),
  policies: def({ type: 'policies', schemaVersion: 1, category: 'trust', label: { ar: 'السياسات', en: 'Policies' }, icon: 'ShieldCheck', props: P.policies, placement: ['page', 'columns'], maxPerPage: 2, actions: false }),
  page_link: def({ type: 'page_link', schemaVersion: 1, category: 'content', label: { ar: 'رابط صفحة إضافية', en: 'Additional page link' }, icon: 'FileText', props: P.page_link, placement: ['page', 'columns'], maxPerPage: 12, actions: false,
    defaults: () => ({ image_asset_id: null }) }),
  welcome: def({ type: 'welcome', schemaVersion: 1, category: 'content', label: { ar: 'رسالة ترحيب', en: 'Welcome message' }, icon: 'Hand', props: P.welcome, placement: ['page'], maxPerPage: 1, actions: true,
    defaults: () => ({ message: { ar: 'أهلاً بكِ في صالوننا', en: 'Welcome to our salon' }, style: 'banner', dismissible: true }) }),
  spacer: def({ type: 'spacer', schemaVersion: 1, category: 'layout', label: { ar: 'مسافة / فاصل', en: 'Spacer / divider' }, icon: 'SeparatorHorizontal', props: P.spacer, placement: ['page', 'columns'], maxPerPage: 30, actions: false }),
  columns: def({ type: 'columns', schemaVersion: 1, category: 'layout', label: { ar: 'أعمدة', en: 'Columns' }, icon: 'Columns3', props: P.columns, placement: ['page'], maxPerPage: 10, actions: false }),
};

// ── Block document ───────────────────────────────────────────────────────────
export const MAX_BLOCKS_PER_PAGE = 80;
export const MAX_CHILDREN = 6;
export const zBlockId = z.string().regex(/^[a-zA-Z0-9_-]{6,40}$/);

export type PageBlock = {
  id: string;
  type: BlockType;
  schemaVersion: number;
  props: Record<string, unknown>;
  visibility: { enabled: boolean; mobile?: boolean; desktop?: boolean };
  action?: BlockAction;
  children?: PageBlock[];
};

const zVisibility = z.object({ enabled: z.boolean(), mobile: z.boolean().optional(), desktop: z.boolean().optional() }).strict();

export const zRawBlock: z.ZodType<PageBlock> = z.lazy(() =>
  z.object({
    id: zBlockId,
    type: z.enum(BLOCK_TYPES as [BlockType, ...BlockType[]]),
    schemaVersion: z.number().int().min(1),
    props: z.record(z.string(), z.unknown()),
    visibility: zVisibility,
    action: zAction.optional(),
    children: z.array(zRawBlock).max(MAX_CHILDREN).optional(),
  }).strict(),
) as z.ZodType<PageBlock>;

export type BlockIssue = { blockId: string | null; path: string; code: string; message: string };

/** Upgrades older block props through the registry's migrations. */
export function migrateBlock(b: PageBlock): PageBlock {
  const d = BLOCKS[b.type];
  if (!d) return b;
  let props = b.props;
  if (b.schemaVersion < d.schemaVersion && d.migrate) props = d.migrate(props, b.schemaVersion);
  return { ...b, schemaVersion: d.schemaVersion, props, children: b.children?.map(migrateBlock) };
}

/**
 * Structural validation (schema, nesting, limits, actions). Reference checks
 * against the tenant's catalog happen server-side in the builder service.
 * Returns normalised blocks (defaults applied) and issues.
 */
export function validateBlocks(input: unknown): { blocks: PageBlock[]; issues: BlockIssue[] } {
  const issues: BlockIssue[] = [];
  const arr = z.array(zRawBlock).max(MAX_BLOCKS_PER_PAGE).safeParse(input);
  if (!arr.success) {
    for (const i of arr.error.issues.slice(0, 20)) issues.push({ blockId: null, path: i.path.join('.'), code: 'invalid_structure', message: i.message });
    return { blocks: [], issues };
  }
  const counts = new Map<BlockType, number>();
  const ids = new Set<string>();
  let total = 0;
  const walk = (list: PageBlock[], where: 'page' | 'columns'): PageBlock[] =>
    list.map((raw) => {
      total++;
      const b = migrateBlock(raw);
      const d = BLOCKS[b.type];
      if (ids.has(b.id)) issues.push({ blockId: b.id, path: 'id', code: 'duplicate_id', message: 'Duplicate block id' });
      ids.add(b.id);
      counts.set(b.type, (counts.get(b.type) ?? 0) + 1);
      if (!d.placement.includes(where)) issues.push({ blockId: b.id, path: 'type', code: 'invalid_nesting', message: `${b.type} cannot be placed inside ${where}` });
      if (b.action && !d.actions) issues.push({ blockId: b.id, path: 'action', code: 'action_not_supported', message: `${b.type} does not support click actions` });
      const parsed = d.props.safeParse(b.props);
      let props = b.props;
      if (!parsed.success) {
        for (const i of parsed.error.issues.slice(0, 10)) issues.push({ blockId: b.id, path: `props.${i.path.join('.')}`, code: 'invalid_props', message: i.message });
      } else props = parsed.data as Record<string, unknown>;
      let children: PageBlock[] | undefined;
      if (b.type === 'columns') {
        children = walk(b.children ?? [], 'columns');
        const count = (props as { count?: number }).count ?? 2;
        if ((b.children?.length ?? 0) > count * 2) issues.push({ blockId: b.id, path: 'children', code: 'too_many_children', message: 'Too many blocks in columns' });
      } else if (b.children?.length) {
        issues.push({ blockId: b.id, path: 'children', code: 'invalid_nesting', message: `${b.type} cannot contain blocks` });
      }
      return { ...b, props, ...(children ? { children } : {}) };
    });
  const blocks = walk(arr.data, 'page');
  if (total > MAX_BLOCKS_PER_PAGE) issues.push({ blockId: null, path: '', code: 'too_many_blocks', message: `At most ${MAX_BLOCKS_PER_PAGE} blocks per page` });
  for (const [type, n] of counts) {
    if (n > BLOCKS[type].maxPerPage) issues.push({ blockId: null, path: type, code: 'block_limit', message: `At most ${BLOCKS[type].maxPerPage} ${type} blocks per page` });
  }
  return { blocks, issues };
}

/** Collects catalog/page/asset references for server-side ownership checks. */
export function collectReferences(blocks: PageBlock[]) {
  const refs = { services: new Set<string>(), products: new Set<string>(), categories: new Set<string>(), staff: new Set<string>(), pages: new Set<string>(), packages: new Set<string>(), branches: new Set<string>(), assets: new Set<string>(), sections: new Set<string>() };
  const add = (set: Set<string>, v: unknown) => { if (typeof v === 'string' && v) set.add(v); };
  const visit = (b: PageBlock) => {
    const p = b.props as Record<string, any>;
    add(refs.assets, p.image_asset_id);
    (p.items ?? []).forEach((i: any) => add(refs.assets, i?.image_asset_id));
    (p.service_ids ?? []).forEach((v: unknown) => add(refs.services, v));
    add(refs.services, p.service_id);
    (p.product_ids ?? []).forEach((v: unknown) => add(refs.products, v));
    add(refs.products, p.product_id);
    add(refs.categories, p.category_id);
    (p.staff_ids ?? []).forEach((v: unknown) => add(refs.staff, v));
    (p.package_ids ?? []).forEach((v: unknown) => add(refs.packages, v));
    (p.page_ids ?? []).forEach((v: unknown) => add(refs.pages, v));
    add(refs.pages, p.page_id);
    add(refs.branches, p.branch_id);
    if (b.action) {
      const a = b.action;
      if (a.type === 'service' || (a.type === 'start_booking' && a.targetId)) add(refs.services, a.targetId);
      if (a.type === 'product') add(refs.products, a.targetId);
      if (a.type === 'category') add(refs.categories, a.targetId);
      if (a.type === 'staff') add(refs.staff, a.targetId);
      if (a.type === 'page') add(refs.pages, a.targetId);
      if (a.type === 'section') add(refs.sections, a.targetId);
    }
    b.children?.forEach(visit);
  };
  blocks.forEach(visit);
  return refs;
}

export function newBlockId() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = 'b_';
  const rnd = typeof crypto !== 'undefined' && 'getRandomValues' in crypto ? crypto.getRandomValues(new Uint8Array(12)) : Array.from({ length: 12 }, () => Math.floor(Math.random() * 256));
  for (const n of rnd) s += alphabet[n % alphabet.length];
  return s;
}

export function makeBlock(type: BlockType, overrides: Partial<PageBlock> = {}): PageBlock {
  const d = BLOCKS[type];
  return {
    id: newBlockId(), type, schemaVersion: d.schemaVersion, props: d.defaults(), visibility: { enabled: true },
    ...(type === 'columns' ? { children: [] } : {}), ...overrides,
  };
}

// ── Site layout (navigation, header, footer) ─────────────────────────────────
export const zLayout = z.object({
  nav_style: z.enum(['simple', 'pill', 'bottom']).default('simple'),
  header: z.object({ show_logo: z.boolean().default(true), show_name: z.boolean().default(true), sticky: z.boolean().default(true), show_book_button: z.boolean().default(true) }).strict().default({ show_logo: true, show_name: true, sticky: true, show_book_button: true }),
  footer: z.object({ show_social: z.boolean().default(true), show_hours: z.boolean().default(true), show_policies: z.boolean().default(true), show_powered_by: z.boolean().default(true) }).strict().default({ show_social: true, show_hours: true, show_policies: true, show_powered_by: true }),
  /** Always-available booking entry (cannot be removed): floating button or header button. */
  booking_entry: z.enum(['header', 'floating', 'both']).default('both'),
  service_display: z.enum(['list', 'cards']).default('cards'),
  product_display: z.enum(['grid', 'list']).default('grid'),
}).strict();
export type SiteLayout = z.infer<typeof zLayout>;
export const DEFAULT_LAYOUT: SiteLayout = zLayout.parse({});

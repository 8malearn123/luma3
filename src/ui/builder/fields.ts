import type { BlockType } from '@/shared/builder/blocks';

/**
 * Properties-panel field definitions per block type. Labels come from
 * `builder.f.<key>` and option labels from `builder.o.<value>`. Every field
 * maps onto a prop in the registry schema, so the editor can only produce
 * valid configuration.
 */
export type RefKind = 'service' | 'product' | 'category' | 'page' | 'branch' | 'staff' | 'package';
export type FieldSpec =
  | { k: 'localized'; key: string; multiline?: boolean; max?: number }
  | { k: 'rich'; key: string }
  | { k: 'select'; key: string; options: readonly string[] }
  | { k: 'number'; key: string; min: number; max: number; step?: number }
  | { k: 'boolean'; key: string }
  | { k: 'image'; key: string; purpose: 'cover' | 'block' | 'gallery' }
  | { k: 'ref'; key: string; ref: RefKind; nullable?: boolean; categoryKind?: 'service' | 'product' }
  | { k: 'refs'; key: string; ref: RefKind }
  | { k: 'gallery'; key: string }
  | { k: 'faq'; key: string };

const align = { k: 'select', key: 'align', options: ['start', 'center', 'end'] } as const;
const focal = { k: 'select', key: 'focal', options: ['center', 'top', 'bottom', 'start', 'end'] } as const;
const title = { k: 'localized', key: 'title' } as const;

export const FIELD_SPECS: Record<BlockType, FieldSpec[]> = {
  hero: [title, { k: 'localized', key: 'subtitle' }, { k: 'localized', key: 'cta_label' }, { k: 'image', key: 'image_asset_id', purpose: 'cover' }, focal,
    { k: 'number', key: 'overlay', min: 0, max: 0.8, step: 0.05 }, align, { k: 'select', key: 'height', options: ['sm', 'md', 'lg'] }],
  image_ad: [{ k: 'image', key: 'image_asset_id', purpose: 'block' }, { k: 'localized', key: 'alt' }, { k: 'localized', key: 'caption' }, { k: 'select', key: 'aspect', options: ['16:9', '3:1', '4:3', '1:1'] }, focal],
  image: [{ k: 'image', key: 'image_asset_id', purpose: 'block' }, { k: 'localized', key: 'alt' }, { k: 'select', key: 'aspect', options: ['auto', '16:9', '4:3', '1:1', '3:4'] }, focal, { k: 'boolean', key: 'rounded' }],
  text: [{ k: 'rich', key: 'content' }, align, { k: 'select', key: 'background', options: ['none', 'surface', 'primary', 'secondary', 'accent'] }],
  cta: [{ k: 'localized', key: 'label' }, { k: 'select', key: 'style', options: ['primary', 'secondary', 'outline'] }, align, { k: 'boolean', key: 'full_width' }],
  service_list: [title, { k: 'select', key: 'display', options: ['cards', 'list'] }, { k: 'ref', key: 'category_id', ref: 'category', nullable: true, categoryKind: 'service' },
    { k: 'refs', key: 'service_ids', ref: 'service' }, { k: 'number', key: 'columns', min: 1, max: 4 }, { k: 'boolean', key: 'show_prices' }, { k: 'boolean', key: 'show_durations' }, { k: 'boolean', key: 'group_by_category' }],
  service_feature: [{ k: 'ref', key: 'service_id', ref: 'service' }, { k: 'select', key: 'layout', options: ['image_start', 'image_end', 'stacked'] }, { k: 'boolean', key: 'show_price' }],
  categories: [title, { k: 'select', key: 'kind', options: ['service', 'product'] }, { k: 'select', key: 'display', options: ['chips', 'tiles'] }],
  product_grid: [title, { k: 'select', key: 'display', options: ['grid', 'list'] }, { k: 'ref', key: 'category_id', ref: 'category', nullable: true, categoryKind: 'product' },
    { k: 'refs', key: 'product_ids', ref: 'product' }, { k: 'number', key: 'columns', min: 1, max: 4 }, { k: 'boolean', key: 'show_prices' }],
  product_feature: [{ k: 'ref', key: 'product_id', ref: 'product' }, { k: 'select', key: 'layout', options: ['image_start', 'image_end', 'stacked'] }],
  team: [title, { k: 'refs', key: 'staff_ids', ref: 'staff' }, { k: 'select', key: 'display', options: ['cards', 'avatars'] }, { k: 'boolean', key: 'show_bios' }],
  gallery: [title, { k: 'gallery', key: 'items' }, { k: 'select', key: 'layout', options: ['grid', 'masonry', 'carousel'] }, { k: 'number', key: 'columns', min: 2, max: 5 }, { k: 'boolean', key: 'lightbox' }],
  offers: [title, { k: 'refs', key: 'package_ids', ref: 'package' }, { k: 'select', key: 'display', options: ['cards', 'list'] }],
  reviews: [title, { k: 'number', key: 'min_rating', min: 1, max: 5 }, { k: 'number', key: 'limit', min: 1, max: 20 }, { k: 'boolean', key: 'show_staff' }],
  intro: [title, { k: 'rich', key: 'body' }, { k: 'image', key: 'image_asset_id', purpose: 'block' }, { k: 'select', key: 'layout', options: ['image_start', 'image_end', 'text_only'] }],
  map: [title, { k: 'ref', key: 'branch_id', ref: 'branch', nullable: true }, { k: 'number', key: 'zoom', min: 10, max: 18 }],
  hours: [title, { k: 'ref', key: 'branch_id', ref: 'branch', nullable: true }],
  contact: [title, { k: 'boolean', key: 'show_phone' }, { k: 'boolean', key: 'show_whatsapp' }, { k: 'boolean', key: 'show_email' }, { k: 'boolean', key: 'show_address' }],
  social: [title, { k: 'select', key: 'style', options: ['icons', 'buttons'] }],
  faq: [title, { k: 'faq', key: 'items' }],
  policies: [title, { k: 'refs', key: 'page_ids', ref: 'page' }],
  page_link: [{ k: 'ref', key: 'page_id', ref: 'page' }, { k: 'localized', key: 'label' }, { k: 'localized', key: 'description' }, { k: 'image', key: 'image_asset_id', purpose: 'block' }],
  welcome: [{ k: 'localized', key: 'message' }, { k: 'select', key: 'style', options: ['banner', 'card'] }, { k: 'boolean', key: 'dismissible' }],
  spacer: [{ k: 'select', key: 'size', options: ['sm', 'md', 'lg'] }, { k: 'boolean', key: 'divider' }],
  columns: [{ k: 'number', key: 'count', min: 2, max: 3 }, { k: 'select', key: 'gap', options: ['sm', 'md', 'lg'] }, { k: 'boolean', key: 'stack_on_mobile' }],
};

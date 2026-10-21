import { sql } from 'kysely';
import { db, withTenant, type Tx } from '../../db/client';
import { hashToken } from '../../auth/crypto';
import { loadEntitlements } from '../../tenancy/access';
import { isSafeExternalUrl, type PageBlock } from '@/shared/builder/blocks';
import {
  SOCIAL_KEYS, type PublicAsset, type PublicBranch, type PublicCategory, type PublicPackage, type PublicProduct, type PublicReview,
  type PublicService, type PublicStaff, type SiteSnapshot, type StorefrontData, type StorefrontMode,
} from '@/shared/builder/storefront';
import { zBrand, NEUTRAL_BRAND } from '@/shared/builder/theme';
import { DEFAULT_LAYOUT, zLayout } from '@/shared/builder/blocks';
import { readDraftSnapshot, safeBlocks } from '../builder/drafts';

/**
 * Public storefront read model. Tenant scope comes from the published slug (or
 * a valid preview token) — never from request input — and every field returned
 * is allowlisted. Costs, commissions, private notes and customer contact data
 * are never selected.
 */

type TenantRow = { id: string; slug: string; name: string; status: string; default_locale: 'ar' | 'en'; timezone: string; currency: string; published_version_id: string | null; business_type: string };

export async function resolveTenantBySlug(slug: string): Promise<TenantRow | null> {
  if (!/^[a-z0-9-]{3,48}$/.test(slug)) return null;
  const r = await sql<TenantRow>`select * from app.resolve_tenant_slug(${slug})`.execute(db());
  return r.rows[0] ?? null;
}

/** A storefront is public only after its first publication and while the business is active. */
export async function resolvePublishedTenant(slug: string): Promise<TenantRow | null> {
  const t = await resolveTenantBySlug(slug);
  if (!t || t.status !== 'active' || !t.published_version_id) return null;
  return t;
}

export async function getPublishedStorefront(slug: string): Promise<StorefrontData | null> {
  const t = await resolvePublishedTenant(slug);
  if (!t) return null;
  return withTenant(t.id, async (trx) => {
    const v = await trx.selectFrom('site_versions').select(['id', 'version_number', 'snapshot', 'published_at'])
      .where('tenant_id', '=', t.id).where('id', '=', t.published_version_id!).executeTakeFirst();
    if (!v) return null;
    const snapshot = normalizeSnapshot(v.snapshot);
    return assemble(trx, t, snapshot, 'published', { id: v.id, number: v.version_number, published_at: v.published_at.toISOString() });
  });
}

/** Draft storefront for a preview token holder (noindex, not tracked). */
export async function getPreviewStorefront(token: string): Promise<StorefrontData | null> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  const r = await sql<{ tenant_id: string | null }>`select app.preview_token_tenant(${hashToken(token, 'preview')}) as tenant_id`.execute(db());
  const tenantId = r.rows[0]?.tenant_id;
  if (!tenantId) return null;
  const data = await getDraftStorefront(tenantId, 'preview');
  return data ? { ...data, previewToken: token } : null;
}

/** Draft storefront for members (builder canvas) or preview tokens. */
export async function getDraftStorefront(tenantId: string, mode: Exclude<StorefrontMode, 'published'>): Promise<StorefrontData | null> {
  return withTenant(tenantId, async (trx) => {
    const t = await trx.selectFrom('tenants').select(['id', 'slug', 'name', 'status', 'default_locale', 'timezone', 'currency', 'published_version_id', 'business_type'])
      .where('id', '=', tenantId).executeTakeFirst();
    if (!t || t.status === 'closed') return null;
    const snapshot = await readDraftSnapshot(trx, tenantId);
    return assemble(trx, { ...t, slug: String(t.slug), default_locale: t.default_locale as 'ar' | 'en' }, snapshot, mode, null);
  });
}

export function normalizeSnapshot(raw: unknown): SiteSnapshot {
  const s = (raw ?? {}) as Partial<SiteSnapshot>;
  const brand = zBrand.safeParse(s.brand);
  const layout = zLayout.safeParse(s.layout);
  return {
    schema_version: 1,
    brand: brand.success ? brand.data : NEUTRAL_BRAND,
    layout: layout.success ? layout.data : DEFAULT_LAYOUT,
    pages: (Array.isArray(s.pages) ? s.pages : []).map((p) => ({ ...p, blocks: safeBlocks(p.blocks) })),
  };
}

async function assemble(trx: Tx, t: TenantRow, snapshot: SiteSnapshot, mode: StorefrontMode, version: StorefrontData['version']): Promise<StorefrontData> {
  const ent = await loadEntitlements(trx, t.id);
  const on = (k: string) => !!ent.features.get(k)?.enabled;
  const productsEnabled = on('feature.products');
  const live = await loadLiveCatalog(trx, t.id, { productsEnabled });
  const assetIds = new Set<string>();
  const addAsset = (id: unknown) => { if (typeof id === 'string') assetIds.add(id); };
  addAsset(snapshot.brand.logo_asset_id);
  const visit = (list: PageBlock[]) => list.forEach((b) => {
    const p = b.props as Record<string, any>;
    addAsset(p.image_asset_id);
    (p.items ?? []).forEach((i: any) => addAsset(i?.image_asset_id));
    if (b.children) visit(b.children);
  });
  snapshot.pages.forEach((p) => visit(p.blocks));
  live.services.forEach((s) => addAsset(s.image_asset_id));
  live.staff.forEach((s) => addAsset(s.photo_asset_id));
  live.products.forEach((p) => p.image_asset_ids.forEach(addAsset));
  const assets: Record<string, PublicAsset> = {};
  if (assetIds.size) {
    const rows = await trx.selectFrom('assets').select(['id', 'width', 'height', 'alt_ar', 'alt_en'])
      .where('tenant_id', '=', t.id).where('id', 'in', [...assetIds]).where('status', '=', 'ready').where('visibility', '=', 'public').execute();
    for (const r of rows) assets[r.id] = { width: r.width, height: r.height, alt_ar: r.alt_ar, alt_en: r.alt_en };
  }
  // Plan policy: "Powered by LUMA" can only be hidden when the plan allows it.
  const poweredBy = !on('feature.remove_powered_by') || snapshot.layout.footer.show_powered_by;
  return {
    mode,
    tenant: { slug: t.slug, name: t.name, currency: t.currency, timezone: t.timezone, default_locale: t.default_locale, business_type: t.business_type },
    brand: snapshot.brand,
    layout: snapshot.layout,
    powered_by: poweredBy,
    pages: snapshot.pages,
    version,
    catalog: { services: live.services, staff: live.staff, products: live.products, categories: live.categories, packages: live.packages, reviews: live.reviews },
    branches: live.branches,
    contact: live.contact,
    assets,
    policy: live.policy,
    features: { products: productsEnabled },
  };
}

function firstName(name: string) {
  const first = name.trim().split(/\s+/)[0] ?? '';
  return first.length > 1 ? first : (first ? `${first}.` : '—');
}

function socialUrl(key: string, v: string): string | null {
  const s = v.trim();
  if (!s) return null;
  if (isSafeExternalUrl(s)) return s;
  const handle = s.replace(/^@/, '');
  if (!/^[A-Za-z0-9._-]{1,60}$/.test(handle)) return null;
  const base: Record<string, string> = { instagram: 'https://instagram.com/', tiktok: 'https://www.tiktok.com/@', snapchat: 'https://www.snapchat.com/add/', x: 'https://x.com/', facebook: 'https://facebook.com/', youtube: 'https://youtube.com/@' };
  return base[key] ? base[key] + handle : null;
}

/** Live catalog data with allowlisted columns only. */
export async function loadLiveCatalog(trx: Tx, tenantId: string, opts: { productsEnabled: boolean }) {
  const cats = await trx.selectFrom('categories').select(['id', 'kind', 'name_ar', 'name_en', 'slug'])
    .where('tenant_id', '=', tenantId).where('archived_at', 'is', null).where('is_visible', '=', true).orderBy('sort').orderBy('created_at').execute();
  const visibleCats = new Set(cats.map((c) => c.id));

  const svcRows = await trx.selectFrom('services')
    .select(['id', 'name_ar', 'name_en', 'description_ar', 'description_en', 'price_minor', 'price_display', 'duration_min', 'image_asset_id', 'category_id'])
    .where('tenant_id', '=', tenantId).where('archived_at', 'is', null).where('is_active', '=', true).where('is_visible', '=', true)
    .orderBy('sort').orderBy('created_at').execute();
  // Hiding a category hides its services publicly (they and their history remain).
  const svcs = svcRows.filter((s) => !s.category_id || visibleCats.has(s.category_id));

  const staffRows = await trx.selectFrom('staff_profiles')
    .select(['id', 'display_name', 'display_name_en', 'title_ar', 'title_en', 'bio_ar', 'bio_en', 'photo_asset_id', 'is_public'])
    .where('tenant_id', '=', tenantId).where('archived_at', 'is', null).where('is_active', '=', true).orderBy('sort').orderBy('created_at').execute();
  const links = svcs.length ? await trx.selectFrom('service_staff').select(['service_id', 'staff_id']).where('tenant_id', '=', tenantId).where('service_id', 'in', svcs.map((s) => s.id)).execute() : [];
  const activeStaff = new Set(staffRows.map((s) => s.id));
  const publicStaff = new Set(staffRows.filter((s) => s.is_public).map((s) => s.id));

  const services: PublicService[] = svcs.map((s) => {
    const qualified = links.filter((l) => l.service_id === s.id && activeStaff.has(l.staff_id));
    return {
      id: s.id, name_ar: s.name_ar, name_en: s.name_en, description_ar: s.description_ar, description_en: s.description_en,
      price_minor: s.price_minor, price_display: s.price_display as PublicService['price_display'], duration_min: s.duration_min,
      image_asset_id: s.image_asset_id, category_id: s.category_id,
      staff_ids: qualified.filter((l) => publicStaff.has(l.staff_id)).map((l) => l.staff_id), bookable: qualified.length > 0,
    };
  });
  const svcIds = new Set(services.map((s) => s.id));
  const staff: PublicStaff[] = staffRows.filter((s) => s.is_public).map((s) => ({
    id: s.id, display_name: s.display_name, display_name_en: s.display_name_en, title_ar: s.title_ar, title_en: s.title_en,
    bio_ar: s.bio_ar, bio_en: s.bio_en, photo_asset_id: s.photo_asset_id,
    service_ids: links.filter((l) => l.staff_id === s.id && svcIds.has(l.service_id)).map((l) => l.service_id),
  }));

  let products: PublicProduct[] = [];
  if (opts.productsEnabled) {
    const prows = await trx.selectFrom('products').select(['id', 'name_ar', 'name_en', 'description_ar', 'description_en', 'category_id', 'hide_when_out_of_stock', 'max_per_order'])
      .where('tenant_id', '=', tenantId).where('status', '=', 'active').where('is_visible', '=', true).orderBy('sort').orderBy('created_at').execute();
    const visible = prows.filter((p) => !p.category_id || visibleCats.has(p.category_id));
    if (visible.length) {
      const ids = visible.map((p) => p.id);
      const [variants, images] = await Promise.all([
        trx.selectFrom('product_variants').select(['id', 'product_id', 'name_ar', 'name_en', 'price_minor', 'is_default', 'sort'])
          .where('tenant_id', '=', tenantId).where('product_id', 'in', ids).where('is_active', '=', true).orderBy('sort').execute(),
        trx.selectFrom('product_images').select(['product_id', 'asset_id']).where('tenant_id', '=', tenantId).where('product_id', 'in', ids).orderBy('sort').execute(),
      ]);
      const stock = variants.length ? await trx.selectFrom('inventory_items').select(['variant_id', sql<number>`sum(on_hand - reserved)`.as('available')])
        .where('tenant_id', '=', tenantId).where('variant_id', 'in', variants.map((v) => v.id)).where('is_active', '=', true).groupBy('variant_id').execute() : [];
      // Variants without an inventory item are not stock-tracked and treated as available.
      const avail = new Map(stock.map((s) => [s.variant_id!, Number(s.available) > 0]));
      products = visible.map((p) => {
        const vs = variants.filter((v) => v.product_id === p.id).map((v) => ({ id: v.id, name_ar: v.name_ar, name_en: v.name_en, price_minor: v.price_minor, is_default: v.is_default, in_stock: avail.get(v.id) ?? true }));
        const def = vs.find((v) => v.is_default) ?? vs[0] ?? null;
        return {
          id: p.id, name_ar: p.name_ar, name_en: p.name_en, description_ar: p.description_ar, description_en: p.description_en, category_id: p.category_id,
          price_minor: def?.price_minor ?? null, default_variant_id: def?.id ?? null, image_asset_ids: images.filter((i) => i.product_id === p.id).map((i) => i.asset_id),
          in_stock: vs.some((v) => v.in_stock), max_per_order: p.max_per_order, variants: vs,
        };
      }).filter((p) => p.variants.length > 0 && !(visible.find((v) => v.id === p.id)?.hide_when_out_of_stock && !p.in_stock));
    }
  }

  const pkgRows = await trx.selectFrom('service_packages').select(['id', 'name_ar', 'name_en', 'description_ar', 'description_en', 'price_minor'])
    .where('tenant_id', '=', tenantId).where('archived_at', 'is', null).where('is_active', '=', true).where('is_visible', '=', true).orderBy('created_at').execute();
  const pkgItems = pkgRows.length ? await trx.selectFrom('service_package_items').select(['package_id', 'service_id']).where('tenant_id', '=', tenantId).where('package_id', 'in', pkgRows.map((p) => p.id)).orderBy('sequence').execute() : [];
  const packages: PublicPackage[] = pkgRows.map((p) => ({ ...p, service_ids: pkgItems.filter((i) => i.package_id === p.id && svcIds.has(i.service_id)).map((i) => i.service_id) }));

  // Reviews: rating, comment, first name only, staff — never customer contact data.
  const revRows = await trx.selectFrom('reviews as r').innerJoin('tenant_customers as c', (j) => j.onRef('c.id', '=', 'r.tenant_customer_id').onRef('c.tenant_id', '=', 'r.tenant_id'))
    .select(['r.id', 'r.rating', 'r.comment', 'r.staff_id', 'r.created_at', 'r.business_reply', 'c.display_name'])
    .where('r.tenant_id', '=', tenantId).where('r.status', '=', 'published').orderBy('r.created_at', 'desc').limit(60).execute();
  const reviews: PublicReview[] = revRows.map((r) => ({
    id: r.id, rating: r.rating, comment: r.comment, author: firstName(r.display_name), staff_id: r.staff_id && publicStaff.has(r.staff_id) ? r.staff_id : null,
    created_at: r.created_at.toISOString(), business_reply: r.business_reply,
  }));

  const brRows = await trx.selectFrom('branches').select(['id', 'name', 'city', 'address', 'latitude', 'longitude', 'phone', 'is_primary', 'timezone'])
    .where('tenant_id', '=', tenantId).where('status', '=', 'active').orderBy('is_primary', 'desc').orderBy('created_at').execute();
  const hours = brRows.length ? await trx.selectFrom('branch_hours').select(['branch_id', 'weekday', 'opens', 'closes']).where('tenant_id', '=', tenantId).orderBy('weekday').orderBy('opens').execute() : [];
  const branches: PublicBranch[] = brRows.map((b) => ({
    ...b, latitude: b.latitude == null ? null : Number(b.latitude), longitude: b.longitude == null ? null : Number(b.longitude),
    hours: hours.filter((h) => h.branch_id === b.id).map((h) => ({ weekday: h.weekday, opens: String(h.opens).slice(0, 5), closes: String(h.closes).slice(0, 5) })),
  }));

  const st = await trx.selectFrom('tenant_settings').select(['contact_phone', 'contact_email', 'contact_whatsapp', 'social_links', 'booking_policy_text_ar', 'booking_policy_text_en',
    'free_cancellation_hours', 'late_cancellation_fee_bp', 'deposit_mode', 'deposit_percent_bp', 'deposit_fixed_minor', 'allow_pay_on_site'])
    .where('tenant_id', '=', tenantId).executeTakeFirst();
  const social: Record<string, string> = {};
  const rawSocial = (st?.social_links ?? {}) as Record<string, unknown>;
  for (const k of SOCIAL_KEYS) {
    const v = rawSocial[k];
    if (typeof v === 'string') { const u = socialUrl(k, v); if (u) social[k] = u; }
  }
  return {
    services, staff, products, packages, reviews, branches,
    categories: cats.map((c) => ({ ...c, kind: c.kind as PublicCategory['kind'] })),
    contact: { phone: st?.contact_phone ?? null, email: st?.contact_email ? String(st.contact_email) : null, whatsapp: st?.contact_whatsapp ?? null, social },
    policy: {
      text_ar: st?.booking_policy_text_ar ?? null, text_en: st?.booking_policy_text_en ?? null, free_cancellation_hours: st?.free_cancellation_hours ?? 24,
      late_cancellation_fee_bp: st?.late_cancellation_fee_bp ?? 0, deposit_mode: (st?.deposit_mode ?? 'none') as StorefrontData['policy']['deposit_mode'],
      deposit_percent_bp: st?.deposit_percent_bp ?? 0, deposit_fixed_minor: st?.deposit_fixed_minor ?? 0, allow_pay_on_site: st?.allow_pay_on_site ?? true,
    },
  };
}

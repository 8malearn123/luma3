import { translate, type Locale } from '@/i18n';
import type { BlockAction, Localized, PageBlock } from '@/shared/builder/blocks';
import { pagePath, type SnapshotPage, type StorefrontData } from '@/shared/builder/storefront';
import { formatMoney } from '@/shared/format';

/**
 * Rendering context shared by the published storefront, the draft preview and
 * the builder canvas (same components everywhere). Pure functions only, so it
 * works in server and client components alike.
 */
export type RenderCtx = {
  data: StorefrontData;
  locale: Locale;
  /** Builder canvas: placeholders for empty blocks, no navigation. */
  canvas?: boolean;
  device?: 'desktop' | 'mobile';
};

export const tr = (ctx: RenderCtx, key: string, vars?: Record<string, string | number>) => translate(ctx.locale, `storefront.${key}`, vars);
export const pk = (ctx: RenderCtx, ar?: string | null, en?: string | null) => (ctx.locale === 'ar' ? ar || en : en || ar) ?? '';
export const L = (ctx: RenderCtx, v: Localized | undefined | null) => (v ? pk(ctx, v.ar, v.en) : '');
export const money = (ctx: RenderCtx, minor: number | null | undefined) => formatMoney(minor, ctx.data.tenant.currency, ctx.locale);

/** Base URL of the storefront for this mode. Preview links stay inside the token-protected preview. */
export function base(ctx: RenderCtx) {
  return ctx.data.mode === 'preview' && ctx.data.previewToken ? `/preview/${ctx.data.previewToken}` : `/s/${ctx.data.tenant.slug}`;
}
const isPreview = (ctx: RenderCtx) => ctx.data.mode === 'preview';

export function hrefPage(ctx: RenderCtx, p: Pick<SnapshotPage, 'kind' | 'slug'>, hash?: string) {
  const h = hash ? `#${hash}` : '';
  if (isPreview(ctx)) return p.kind === 'home' ? `${base(ctx)}${h}` : `${base(ctx)}?page=${encodeURIComponent(p.slug)}${h}`;
  return `${base(ctx)}${pagePath(p)}${h}` || '/';
}
export const hrefHome = (ctx: RenderCtx) => base(ctx);
export const hrefPolicies = (ctx: RenderCtx) => (isPreview(ctx) ? `${base(ctx)}?page=policies` : `${base(ctx)}/policies`);
export const hrefService = (ctx: RenderCtx, id: string) => (isPreview(ctx) ? `${base(ctx)}?service=${id}` : `${base(ctx)}/services/${id}`);
export const hrefProduct = (ctx: RenderCtx, id: string) => (isPreview(ctx) ? `${base(ctx)}?product=${id}` : `${base(ctx)}/products/${id}`);
export const hrefStaff = (ctx: RenderCtx, id: string) => (isPreview(ctx) ? `${base(ctx)}?staff=${id}` : `${base(ctx)}/team/${id}`);
export const hrefServices = (ctx: RenderCtx, categoryId?: string | null) =>
  isPreview(ctx) ? `${base(ctx)}?page=services${categoryId ? `&category=${categoryId}` : ''}` : `${base(ctx)}/services${categoryId ? `?category=${categoryId}` : ''}`;
export const hrefProducts = (ctx: RenderCtx, categoryId?: string | null) =>
  isPreview(ctx) ? `${base(ctx)}?page=products${categoryId ? `&category=${categoryId}` : ''}` : `${base(ctx)}/products${categoryId ? `?category=${categoryId}` : ''}`;

/**
 * Booking flow URL contract (owned by the booking domain):
 *   /s/{slug}/booking?service={serviceId}&staff={staffId}
 * Disabled in previews (drafts never take real bookings).
 */
export function hrefBooking(ctx: RenderCtx, opts: { service?: string | null; staff?: string | null } = {}) {
  if (isPreview(ctx)) return null;
  const q = new URLSearchParams();
  if (opts.service) q.set('service', opts.service);
  if (opts.staff) q.set('staff', opts.staff);
  const s = q.toString();
  return `/s/${ctx.data.tenant.slug}/booking${s ? `?${s}` : ''}`;
}

/** Cart URL contract (owned by the commerce domain): /s/{slug}/cart?add={variantId}&qty=1 */
export function hrefCart(ctx: RenderCtx, variantId: string, qty = 1) {
  if (isPreview(ctx)) return null;
  return `/s/${ctx.data.tenant.slug}/cart?add=${encodeURIComponent(variantId)}&qty=${qty}`;
}

export const pageByKind = (ctx: RenderCtx, kind: string) => ctx.data.pages.find((p) => p.kind === kind);
export const pageById = (ctx: RenderCtx, id: string) => ctx.data.pages.find((p) => p.id === id);
export const serviceById = (ctx: RenderCtx, id: string) => ctx.data.catalog.services.find((s) => s.id === id);
export const productById = (ctx: RenderCtx, id: string) => ctx.data.catalog.products.find((s) => s.id === id);
export const staffById = (ctx: RenderCtx, id: string) => ctx.data.catalog.staff.find((s) => s.id === id);

/**
 * Resolves a block action to a link. Broken targets (archived/hidden service,
 * removed page) fall back to a sensible public page instead of a dead link.
 */
export function actionHref(ctx: RenderCtx, action: BlockAction | undefined, pageBlocks: PageBlock[] = []): { href: string | null; external?: boolean; broken?: boolean } {
  if (!action) return { href: null };
  switch (action.type) {
    case 'start_booking': {
      const svc = action.targetId ? serviceById(ctx, action.targetId) : null;
      return { href: hrefBooking(ctx, { service: svc?.id ?? null }), broken: !!action.targetId && !svc };
    }
    case 'service': {
      const svc = serviceById(ctx, action.targetId);
      return svc ? { href: hrefService(ctx, svc.id) } : { href: hrefServices(ctx), broken: true };
    }
    case 'product': {
      const p = productById(ctx, action.targetId);
      return p ? { href: hrefProduct(ctx, p.id) } : { href: ctx.data.features.products ? hrefProducts(ctx) : hrefHome(ctx), broken: true };
    }
    case 'category': {
      const c = ctx.data.catalog.categories.find((x) => x.id === action.targetId);
      if (!c) return { href: hrefServices(ctx), broken: true };
      return { href: c.kind === 'product' ? hrefProducts(ctx, c.id) : hrefServices(ctx, c.id) };
    }
    case 'staff': {
      const s = staffById(ctx, action.targetId);
      return s ? { href: hrefStaff(ctx, s.id) } : { href: hrefPage(ctx, { kind: 'team', slug: 'team' }), broken: true };
    }
    case 'page': {
      const p = pageById(ctx, action.targetId);
      return p ? { href: hrefPage(ctx, p) } : { href: hrefHome(ctx), broken: true };
    }
    case 'section': {
      const exists = pageBlocks.some((b) => b.id === action.targetId || b.children?.some((c) => c.id === action.targetId));
      return { href: `#${action.targetId}`, broken: !exists };
    }
    case 'external':
      return { href: action.url, external: true };
  }
}

import { sql } from 'kysely';
import type { z } from 'zod';
import { withTenant, type Tx } from '../../db/client';
import { Errors, isPgCode } from '../../http/errors';
import { audit, type AuditActor } from '../../infra/audit';
import { aiStatus } from '../../infra/ai';
import { featureEnabled, requireWithinLimit, type TenantAccess } from '../../tenancy/access';
import { readiness } from '../onboarding/service';
import { getDraftStorefront } from '../storefront/service';
import { readBrand, writeBrand } from './brand';
import { readDraftPages, readLayout, safeBlocks } from './drafts';
import { parseLayout, validatePage, type PageIssue, type RefWarning } from './validation';
import { makeBlock, type PageBlock, type SiteLayout } from '@/shared/builder/blocks';
import { contrastWarnings, type Brand } from '@/shared/builder/theme';
import { RESERVED_PAGE_SLUGS } from '@/shared/builder/storefront';
import type { createPageInput, updatePageInput } from '@/shared/builder/api';

export const ASSISTANT_PROMPT_KEY = 'builder.customize';

function productsOn(access: TenantAccess) {
  return featureEnabled(access, 'feature.products');
}

/** Plan policy summary the editor needs (enforced server-side regardless). */
export function builderPolicy(access: TenantAccess) {
  const pages = access.plan.features.get('limit.custom_pages');
  return {
    can_remove_powered_by: featureEnabled(access, 'feature.remove_powered_by'),
    custom_pages_limit: pages?.enabled ? pages.limit : 0,
    customization_ai: featureEnabled(access, 'feature.customization_ai'),
    products: productsOn(access),
  };
}

export async function assistantStatus(access: TenantAccess) {
  if (!featureEnabled(access, 'feature.customization_ai')) return { state: 'plan_disabled' as const };
  const last = await withTenant(access.tenantId, (trx) => trx.selectFrom('ai_runs').select('created_at').where('tenant_id', '=', access.tenantId)
    .where('prompt_key', '=', ASSISTANT_PROMPT_KEY).where('status', '=', 'succeeded').orderBy('created_at', 'desc').executeTakeFirst());
  return aiStatus(last?.created_at ?? null);
}

/** Validation issues + reference warnings for every active page and the layout. */
export async function validateDraft(trx: Tx, access: TenantAccess) {
  const pages = await readDraftPages(trx, access.tenantId);
  const issues: PageIssue[] = [];
  const warnings: RefWarning[] = [];
  for (const p of pages) {
    const r = await validatePage(trx, access.tenantId, p.id, p.blocks, { productsEnabled: productsOn(access) });
    issues.push(...r.issues);
    warnings.push(...r.warnings);
  }
  const lay = await trx.selectFrom('site_drafts').select('layout').where('tenant_id', '=', access.tenantId).executeTakeFirst();
  const pl = parseLayout(lay?.layout);
  issues.push(...pl.issues);
  if (pl.layout && !pl.layout.footer.show_powered_by && !featureEnabled(access, 'feature.remove_powered_by')) {
    issues.push({ pageId: null, blockId: null, path: 'layout.footer.show_powered_by', code: 'powered_by_required', message: 'Your plan requires the "Powered by LUMA" mark' });
  }
  return { issues, warnings };
}

/** Everything the editor needs in one request. */
export async function getBuilderState(access: TenantAccess) {
  const state = await withTenant(access.tenantId, async (trx) => {
    const [brand, layout, pages, validation, published, catalog] = await Promise.all([
      readBrand(trx, access.tenantId),
      readLayout(trx, access.tenantId),
      readDraftPages(trx, access.tenantId, { includeArchived: true }),
      validateDraft(trx, access),
      trx.selectFrom('tenants as t').leftJoin('site_versions as v', (j) => j.onRef('v.id', '=', 't.published_version_id').onRef('v.tenant_id', '=', 't.id'))
        .select(['t.status', 't.published_version_id', 'v.version_number', 'v.published_at']).where('t.id', '=', access.tenantId).executeTakeFirstOrThrow(),
      catalogRefs(trx, access.tenantId),
    ]);
    return { brand, layout, pages, validation, published, catalog };
  });
  const [ready, ai, canvas] = await Promise.all([readiness(access), assistantStatus(access), getDraftStorefront(access.tenantId, 'canvas')]);
  return {
    brand: { ...state.brand.brand, version: state.brand.version },
    brand_version: state.brand.version,
    layout: state.layout.layout,
    layout_version: state.layout.version,
    pages: state.pages.map((p) => ({ ...p, blocks: safeBlocks(p.blocks), updated_at: p.updated_at.toISOString() })),
    validation: state.validation,
    contrast_warnings: contrastWarnings(state.brand.brand.colors),
    readiness: ready,
    ai_status: ai,
    policy: builderPolicy(access),
    published: { tenant_status: state.published.status, version_id: state.published.published_version_id, version_number: state.published.version_number ?? null, published_at: state.published.published_at?.toISOString() ?? null },
    catalog: state.catalog,
    storefront: canvas,
  };
}

/** Lightweight option lists for the properties panel selectors (this tenant only). */
async function catalogRefs(trx: Tx, tenantId: string) {
  const [services, products, staff, categories, packages, branches, assets] = await Promise.all([
    trx.selectFrom('services').select(['id', 'name_ar', 'name_en', 'is_active', 'is_visible', 'archived_at', 'category_id']).where('tenant_id', '=', tenantId).orderBy('sort').execute(),
    trx.selectFrom('products').select(['id', 'name_ar', 'name_en', 'status', 'is_visible', 'category_id']).where('tenant_id', '=', tenantId).orderBy('sort').execute(),
    trx.selectFrom('staff_profiles').select(['id', 'display_name', 'display_name_en', 'is_active', 'is_public', 'archived_at']).where('tenant_id', '=', tenantId).orderBy('sort').execute(),
    trx.selectFrom('categories').select(['id', 'kind', 'name_ar', 'name_en', 'is_visible', 'archived_at']).where('tenant_id', '=', tenantId).orderBy('sort').execute(),
    trx.selectFrom('service_packages').select(['id', 'name_ar', 'name_en', 'is_active', 'is_visible', 'archived_at']).where('tenant_id', '=', tenantId).orderBy('created_at').execute(),
    trx.selectFrom('branches').select(['id', 'name', 'status', 'is_primary']).where('tenant_id', '=', tenantId).orderBy('created_at').execute(),
    trx.selectFrom('assets').select(['id', 'purpose', 'width', 'height', 'alt_ar', 'alt_en', 'created_at']).where('tenant_id', '=', tenantId).where('status', '=', 'ready')
      .where('visibility', '=', 'public').where('kind', '=', 'image').orderBy('created_at', 'desc').limit(120).execute(),
  ]);
  return {
    services: services.map(({ archived_at, ...s }) => ({ ...s, archived: !!archived_at })),
    products: products.map((p) => ({ ...p, archived: p.status === 'archived' })),
    staff: staff.map(({ archived_at, ...s }) => ({ ...s, archived: !!archived_at })),
    categories: categories.map(({ archived_at, ...c }) => ({ ...c, archived: !!archived_at })),
    packages: packages.map(({ archived_at, ...p }) => ({ ...p, archived: !!archived_at })),
    branches,
    assets: assets.map((a) => ({ ...a, created_at: a.created_at.toISOString() })),
  };
}

// ── Draft writes (optimistic concurrency on every document) ─────────────────

export async function writePageBlocks(trx: Tx, access: TenantAccess, actor: AuditActor, pageId: string, expectedVersion: number, raw: unknown) {
  const page = await trx.selectFrom('page_drafts as d').innerJoin('store_pages as p', (j) => j.onRef('p.id', '=', 'd.page_id').onRef('p.tenant_id', '=', 'd.tenant_id'))
    .select(['d.version', 'p.status']).where('d.tenant_id', '=', access.tenantId).where('d.page_id', '=', pageId).forUpdate().executeTakeFirst();
  if (!page) throw Errors.notFound('page');
  if (page.version !== expectedVersion) throw Errors.versionConflict(page.version);
  const v = await validatePage(trx, access.tenantId, pageId, raw, { productsEnabled: productsOn(access) });
  if (v.issues.length) throw Errors.invalid('invalid_blocks', 'Some blocks are invalid', { issues: v.issues });
  const r = await trx.updateTable('page_drafts').set({ blocks: JSON.stringify(v.blocks), version: page.version + 1, updated_by: actor.userId })
    .where('tenant_id', '=', access.tenantId).where('page_id', '=', pageId).where('version', '=', expectedVersion).returning(['version', 'updated_at']).executeTakeFirst();
  if (!r) throw Errors.versionConflict();
  return { page_id: pageId, version: r.version, updated_at: r.updated_at.toISOString(), blocks: v.blocks, warnings: v.warnings };
}

export async function savePageBlocks(access: TenantAccess, actor: AuditActor, pageId: string, input: { version: number; blocks: unknown }) {
  return withTenant(access.tenantId, (trx) => writePageBlocks(trx, access, actor, pageId, input.version, input.blocks));
}

export async function writeLayout(trx: Tx, access: TenantAccess, actor: AuditActor, expectedVersion: number, raw: unknown): Promise<{ layout: SiteLayout; version: number }> {
  const pl = parseLayout(raw);
  if (!pl.layout) throw Errors.invalid('invalid_layout', 'The layout settings are invalid', { issues: pl.issues });
  // Plan policy: the platform mark stays unless the plan allows removing it.
  if (!pl.layout.footer.show_powered_by && !featureEnabled(access, 'feature.remove_powered_by')) throw Errors.planFeature('feature.remove_powered_by');
  const r = await trx.updateTable('site_drafts').set({ layout: JSON.stringify(pl.layout), version: expectedVersion + 1, updated_by: actor.userId })
    .where('tenant_id', '=', access.tenantId).where('version', '=', expectedVersion).returning('version').executeTakeFirst();
  if (!r) {
    const cur = await trx.selectFrom('site_drafts').select('version').where('tenant_id', '=', access.tenantId).executeTakeFirst();
    throw Errors.versionConflict(cur?.version);
  }
  return { layout: pl.layout, version: r.version };
}

export async function saveLayout(access: TenantAccess, actor: AuditActor, input: { version: number; layout: unknown }) {
  return withTenant(access.tenantId, (trx) => writeLayout(trx, access, actor, input.version, input.layout));
}

export async function saveBrand(access: TenantAccess, actor: AuditActor, input: { version: number; brand: Brand }) {
  return withTenant(access.tenantId, async (trx) => {
    const version = await writeBrand(trx, access.tenantId, input.brand, input.version, actor.userId);
    return { version, brand: input.brand, contrast_warnings: contrastWarnings(input.brand.colors) };
  });
}

// ── Pages ───────────────────────────────────────────────────────────────────

async function countCustomPages(trx: Tx, tenantId: string) {
  const r = await trx.selectFrom('store_pages').select(sql<number>`count(*)::int`.as('n')).where('tenant_id', '=', tenantId).where('kind', '=', 'custom').where('status', '=', 'active').executeTakeFirstOrThrow();
  return r.n;
}

function assertSlug(slug: string) {
  if (RESERVED_PAGE_SLUGS.has(slug)) throw Errors.conflict('slug_taken', 'This page address is reserved');
}

export async function createPage(access: TenantAccess, actor: AuditActor, input: z.infer<typeof createPageInput>) {
  assertSlug(input.slug);
  try {
    return await withTenant(access.tenantId, async (trx) => {
      // Serialise concurrent creations so the plan limit cannot be overshot.
      await sql`select pg_advisory_xact_lock(hashtext(${`custom_pages:${access.tenantId}`}))`.execute(trx);
      requireWithinLimit(access, 'limit.custom_pages', await countCustomPages(trx, access.tenantId));
      const max = await trx.selectFrom('store_pages').select(sql<number>`coalesce(max(sort), 0)::int`.as('m')).where('tenant_id', '=', access.tenantId).executeTakeFirstOrThrow();
      const page = await trx.insertInto('store_pages').values({
        tenant_id: access.tenantId, kind: 'custom', slug: input.slug, title_ar: input.title_ar ?? null, title_en: input.title_en ?? null,
        show_in_nav: input.show_in_nav, show_in_footer: input.show_in_footer, sort: max.m + 1,
      }).returningAll().executeTakeFirstOrThrow();
      const blocks: PageBlock[] = [makeBlock('text', { props: { content: { ar: [{ t: 'h2', c: [{ text: input.title_ar ?? input.title_en ?? '' }] }], en: [{ t: 'h2', c: [{ text: input.title_en ?? input.title_ar ?? '' }] }] }, align: 'start', background: 'none' } })];
      await trx.insertInto('page_drafts').values({ tenant_id: access.tenantId, page_id: page.id, blocks: JSON.stringify(blocks), updated_by: actor.userId }).execute();
      await audit(trx, actor, 'storefront.page_created', { tenantId: access.tenantId, targetType: 'store_page', targetId: page.id, data: { slug: input.slug } });
      return { ...page, blocks, version: 1 };
    });
  } catch (e) {
    if (isPgCode(e, '23505')) throw Errors.conflict('slug_taken', 'Another page already uses this address');
    throw e;
  }
}

export async function updatePage(access: TenantAccess, actor: AuditActor, pageId: string, input: z.infer<typeof updatePageInput>) {
  try {
    return await withTenant(access.tenantId, async (trx) => {
      const cur = await trx.selectFrom('store_pages').selectAll().where('tenant_id', '=', access.tenantId).where('id', '=', pageId).forUpdate().executeTakeFirst();
      if (!cur) throw Errors.notFound('page');
      if (input.slug !== undefined && input.slug !== cur.slug) {
        // Default pages keep fixed addresses so their links never break.
        if (cur.kind !== 'custom') throw Errors.invalid('page_slug_fixed', 'This page address cannot be changed');
        assertSlug(input.slug);
      }
      if (input.restore) {
        if (cur.kind !== 'custom') throw Errors.invalid('page_not_archivable');
        if (cur.status === 'archived') {
          await sql`select pg_advisory_xact_lock(hashtext(${`custom_pages:${access.tenantId}`}))`.execute(trx);
          requireWithinLimit(access, 'limit.custom_pages', await countCustomPages(trx, access.tenantId));
        }
      }
      const title_ar = input.title_ar !== undefined ? input.title_ar : cur.title_ar;
      const title_en = input.title_en !== undefined ? input.title_en : cur.title_en;
      if (!title_ar && !title_en) throw Errors.invalid('title_required', 'A page title is required');
      const row = await trx.updateTable('store_pages').set({
        title_ar, title_en,
        ...(input.slug !== undefined ? { slug: input.slug } : {}),
        ...(input.show_in_nav !== undefined ? { show_in_nav: input.show_in_nav } : {}),
        ...(input.show_in_footer !== undefined ? { show_in_footer: input.show_in_footer } : {}),
        ...(input.sort !== undefined ? { sort: input.sort } : {}),
        ...(input.restore ? { status: 'active' } : {}),
      }).where('tenant_id', '=', access.tenantId).where('id', '=', pageId).returningAll().executeTakeFirstOrThrow();
      await audit(trx, actor, 'storefront.page_updated', { tenantId: access.tenantId, targetType: 'store_page', targetId: pageId, data: { fields: Object.keys(input) } });
      return row;
    });
  } catch (e) {
    if (isPgCode(e, '23505')) throw Errors.conflict('slug_taken', 'Another page already uses this address');
    throw e;
  }
}

/** Archive (never delete). Only custom pages; default pages are part of LUMA's structure. */
export async function archivePage(access: TenantAccess, actor: AuditActor, pageId: string) {
  return withTenant(access.tenantId, async (trx) => {
    const cur = await trx.selectFrom('store_pages').select(['kind', 'status']).where('tenant_id', '=', access.tenantId).where('id', '=', pageId).executeTakeFirst();
    if (!cur) throw Errors.notFound('page');
    if (cur.kind !== 'custom') throw Errors.invalid('page_not_archivable', 'Default pages cannot be archived; hide them from navigation instead');
    await trx.updateTable('store_pages').set({ status: 'archived', show_in_nav: false, show_in_footer: false }).where('tenant_id', '=', access.tenantId).where('id', '=', pageId).execute();
    await audit(trx, actor, 'storefront.page_archived', { tenantId: access.tenantId, targetType: 'store_page', targetId: pageId });
    return { id: pageId, status: 'archived' };
  });
}

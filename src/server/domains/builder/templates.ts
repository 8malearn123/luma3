import { z } from 'zod';
import { withTenant } from '../../db/client';
import { Errors } from '../../http/errors';
import { audit, type AuditActor } from '../../infra/audit';
import type { TenantAccess } from '../../tenancy/access';
import { newBlockId, zLayout, type PageBlock } from '@/shared/builder/blocks';
import { zBrand } from '@/shared/builder/theme';
import { readBrand, writeBrand } from './brand';
import { readDraftPages, readLayout } from './drafts';
import { writeLayout, writePageBlocks } from './service';

/**
 * Platform-approved templates (managed by LUMA in the platform console). A
 * business only consumes approved templates. Applying one changes the DRAFT:
 * structure + shape tokens only — never colours, logo, catalog or prices.
 */
const zTemplateDoc = z.object({
  brand: zBrand.pick({ radius: true, button_style: true, card_style: true, density: true, fonts: true }).partial().optional(),
  layout: zLayout.partial().optional(),
  pages: z.record(z.string(), z.array(z.unknown()).max(80)).default({}),
});

export async function listTemplates(access: TenantAccess) {
  return withTenant(access.tenantId, async (trx) => {
    const rows = await trx.selectFrom('templates').select(['id', 'key', 'name_ar', 'name_en', 'description_ar', 'description_en', 'business_types', 'document'])
      .where('status', '=', 'approved').orderBy('created_at').execute();
    return rows.filter((r) => r.business_types.includes(access.businessType)).map(({ document, ...r }) => {
      const doc = zTemplateDoc.safeParse(document);
      return { ...r, pages: doc.success ? Object.keys(doc.data.pages) : [], valid: doc.success, brand: doc.success ? doc.data.brand ?? {} : {}, layout: doc.success ? doc.data.layout ?? {} : {} };
    });
  });
}

function freshIds(blocks: PageBlock[]): PageBlock[] {
  const map = new Map<string, string>();
  const walk = (list: PageBlock[]): PageBlock[] => list.map((b) => {
    const id = newBlockId();
    map.set(b.id, id);
    return { ...b, id, ...(b.children ? { children: walk(b.children) } : {}) };
  });
  const out = walk(blocks);
  // Keep in-page section links pointing at the renamed blocks.
  const fix = (list: PageBlock[]): PageBlock[] => list.map((b) => ({
    ...b,
    ...(b.action?.type === 'section' && map.has(b.action.targetId) ? { action: { type: 'section' as const, targetId: map.get(b.action.targetId)! } } : {}),
    ...(b.children ? { children: fix(b.children) } : {}),
  }));
  return fix(out);
}

export async function applyTemplate(access: TenantAccess, actor: AuditActor, templateId: string, opts: { pages?: string[] }) {
  return withTenant(access.tenantId, async (trx) => {
    const t = await trx.selectFrom('templates').select(['id', 'key', 'document', 'business_types']).where('id', '=', templateId).where('status', '=', 'approved').executeTakeFirst();
    if (!t || !t.business_types.includes(access.businessType)) throw Errors.notFound('template');
    const doc = zTemplateDoc.safeParse(t.document);
    if (!doc.success) throw Errors.invalid('template_invalid', 'This template is not valid anymore');

    if (doc.data.brand && Object.keys(doc.data.brand).length) {
      const cur = await readBrand(trx, access.tenantId);
      await writeBrand(trx, access.tenantId, { ...cur.brand, ...doc.data.brand, fonts: { ...cur.brand.fonts, ...(doc.data.brand.fonts ?? {}) } }, cur.version, actor.userId);
    }
    if (doc.data.layout && Object.keys(doc.data.layout).length) {
      const cur = await readLayout(trx, access.tenantId);
      // Never changes the platform mark or the always-present booking entry.
      const { footer: _f, booking_entry: _b, ...rest } = doc.data.layout;
      await writeLayout(trx, access, actor, cur.version, { ...cur.layout, ...rest });
    }
    const pages = await readDraftPages(trx, access.tenantId);
    const applied: string[] = [];
    for (const [kind, blocks] of Object.entries(doc.data.pages)) {
      if (opts.pages && !opts.pages.includes(kind)) continue;
      const page = pages.find((p) => p.kind === kind);
      if (!page) continue;
      await writePageBlocks(trx, access, actor, page.id, page.version, freshIds(blocks as PageBlock[]));
      applied.push(kind);
    }
    await audit(trx, actor, 'storefront.template_applied', { tenantId: access.tenantId, targetType: 'template', targetId: t.id, data: { key: t.key, pages: applied } });
    return { template_key: t.key, pages: applied };
  });
}

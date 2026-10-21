import type { z } from 'zod';
import { db, sql, withSystem } from '../../db/client';
import { Errors } from '../../http/errors';
import { audit, type AuditActor } from '../../infra/audit';
import { BLOCK_TYPES, BLOCKS, collectReferences, validateBlocks, zLayout, type BlockIssue } from '@/shared/builder/blocks';
import type { templateInput, templatePatch } from '@/shared/schemas/platform';

/**
 * LUMA-approved storefront templates. A template document is
 *   { layout: SiteLayout, pages: [{ kind, blocks: PageBlock[] }] }
 * validated with the same block registry the builder uses (schemas, nesting,
 * limits, safe actions). Templates must not reference any tenant's catalog,
 * pages or assets (they are shared starting points).
 *
 * Contract for the builder domain: only templates with status 'approved'
 * are exposed to businesses — use listApprovedTemplates()/getApprovedTemplate().
 */
type Doc = { layout: unknown; pages: Array<{ kind: string; blocks: unknown }> };

export function validateTemplateDocument(doc: Doc) {
  const issues: Array<BlockIssue & { page?: number }> = [];
  const layout = zLayout.safeParse(doc.layout ?? {});
  if (!layout.success) for (const i of layout.error.issues.slice(0, 10)) issues.push({ blockId: null, path: `layout.${i.path.join('.')}`, code: 'invalid_layout', message: i.message });
  const pages = doc.pages.map((p, idx) => {
    const r = validateBlocks(p.blocks);
    for (const i of r.issues) issues.push({ ...i, page: idx });
    const refs = collectReferences(r.blocks);
    const tenantRefs = [refs.services, refs.products, refs.categories, refs.staff, refs.pages, refs.packages, refs.branches, refs.assets].reduce((n, set) => n + set.size, 0);
    if (tenantRefs > 0) issues.push({ blockId: null, path: `pages.${idx}`, code: 'tenant_reference', message: 'Templates cannot reference a business\'s catalog, pages or images', page: idx });
    return { kind: p.kind, blocks: r.blocks };
  });
  return { document: { layout: layout.success ? layout.data : null, pages }, issues };
}

function assertValid(doc: Doc) {
  const v = validateTemplateDocument(doc);
  if (v.issues.length) throw Errors.invalid('invalid_template', 'The template document is invalid', { issues: v.issues.slice(0, 30) });
  return v.document;
}

export async function listTemplates(status?: string) {
  let q = db().selectFrom('templates').select(['id', 'key', 'name_ar', 'name_en', 'description_ar', 'description_en', 'business_types', 'status', 'version', 'approved_at', 'created_at', 'updated_at']);
  if (status) q = q.where('status', '=', status);
  return q.orderBy('status').orderBy('created_at', 'desc').execute();
}

export async function getTemplate(id: string) {
  const t = await db().selectFrom('templates').selectAll().where('id', '=', id).executeTakeFirst();
  if (!t) throw Errors.notFound('template');
  return t;
}

export async function createTemplate(actor: AuditActor, input: z.infer<typeof templateInput>) {
  const document = assertValid(input.document as Doc);
  return withSystem('platform: create template', async (trx) => {
    const row = await trx.insertInto('templates').values({
      key: input.key, name_ar: input.name_ar, name_en: input.name_en, description_ar: input.description_ar ?? null, description_en: input.description_en ?? null,
      business_types: input.business_types, document: JSON.stringify(document), status: 'draft', created_by: actor.userId, updated_by: actor.userId,
    }).returningAll().executeTakeFirstOrThrow();
    await audit(trx, actor, 'platform.template.created', { targetType: 'template', targetId: row.id, data: { key: input.key } });
    return row;
  });
}

/** Editing an approved template returns it to draft: changes need a fresh approval. */
export async function updateTemplate(id: string, actor: AuditActor, input: z.infer<typeof templatePatch>) {
  const document = input.document ? assertValid(input.document as Doc) : undefined;
  return withSystem('platform: edit template', async (trx) => {
    const cur = await trx.selectFrom('templates').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
    if (!cur) throw Errors.notFound('template');
    if (cur.version !== input.version) throw Errors.versionConflict(cur.version);
    const { version: _v, document: _d, ...fields } = input;
    const row = await trx.updateTable('templates').set({
      ...fields, ...(document ? { document: JSON.stringify(document) } : {}),
      status: cur.status === 'approved' ? 'draft' : cur.status, approved_at: cur.status === 'approved' ? null : cur.approved_at,
      version: cur.version + 1, updated_by: actor.userId,
    }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
    await audit(trx, actor, 'platform.template.updated', { targetType: 'template', targetId: id, data: { fields: Object.keys(fields), document: !!document } });
    return row;
  });
}

export async function setTemplateStatus(id: string, actor: AuditActor, input: { status: 'draft' | 'approved' | 'retired'; version: number }) {
  return withSystem('platform: review template', async (trx) => {
    const cur = await trx.selectFrom('templates').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
    if (!cur) throw Errors.notFound('template');
    if (cur.version !== input.version) throw Errors.versionConflict(cur.version);
    if (input.status === 'approved') assertValid(cur.document as Doc); // re-validate against the current registry
    const row = await trx.updateTable('templates').set({
      status: input.status, version: cur.version + 1, updated_by: actor.userId,
      ...(input.status === 'approved' ? { approved_by: actor.userId, approved_at: new Date() } : {}),
    }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
    await audit(trx, actor, `platform.template.${input.status === 'approved' ? 'approved' : input.status === 'retired' ? 'retired' : 'returned_to_draft'}`, { targetType: 'template', targetId: id, data: { key: cur.key } });
    return row;
  });
}

/** For businesses (builder domain): approved templates only, optionally for a business type. */
export async function listApprovedTemplates(businessType?: string) {
  let q = db().selectFrom('templates').select(['id', 'key', 'name_ar', 'name_en', 'description_ar', 'description_en', 'business_types', 'document', 'version'])
    .where('status', '=', 'approved');
  if (businessType) q = q.where(sql<boolean>`business_types @> array[${businessType}]::text[]`);
  return q.orderBy('name_en').execute();
}

export async function getApprovedTemplate(idOrKey: string) {
  const isId = /^[0-9a-f-]{36}$/i.test(idOrKey);
  const t = await db().selectFrom('templates').selectAll().where(isId ? 'id' : 'key', '=', idOrKey).where('status', '=', 'approved').executeTakeFirst();
  if (!t) throw Errors.notFound('template');
  return t;
}

// ── Builder components ──────────────────────────────────────────────────────
export async function listComponents() {
  const rows = await db().selectFrom('builder_components').selectAll().execute();
  return BLOCK_TYPES.map((type) => {
    const r = rows.find((x) => x.type === type);
    const d = BLOCKS[type];
    return { type, label: d.label, category: d.category, icon: d.icon, is_enabled: r?.is_enabled ?? true, min_plan_feature: r?.min_plan_feature ?? d.feature ?? null, updated_at: r?.updated_at ?? null };
  });
}

export async function setComponent(type: string, actor: AuditActor, input: { is_enabled: boolean; min_plan_feature?: string | null }) {
  if (!BLOCK_TYPES.includes(type as (typeof BLOCK_TYPES)[number])) throw Errors.notFound('component');
  return withSystem('platform: builder component availability', async (trx) => {
    await trx.insertInto('builder_components').values({ type, is_enabled: input.is_enabled, min_plan_feature: input.min_plan_feature ?? null, updated_by: actor.userId })
      .onConflict((oc) => oc.column('type').doUpdateSet({ is_enabled: input.is_enabled, min_plan_feature: input.min_plan_feature ?? null, updated_by: actor.userId })).execute();
    await audit(trx, actor, input.is_enabled ? 'platform.component.enabled' : 'platform.component.disabled', { targetType: 'builder_component', targetId: type });
    return { type, ...input };
  });
}

/** For the builder domain: block types the platform has disabled. */
export async function disabledComponentTypes() {
  const rows = await db().selectFrom('builder_components').select('type').where('is_enabled', '=', false).execute();
  return rows.map((r) => r.type);
}

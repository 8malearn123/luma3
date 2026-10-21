import { sql } from 'kysely';
import { withTenant, type Tx } from '../../db/client';
import { newToken, hashToken } from '../../auth/crypto';
import { AppError, Errors } from '../../http/errors';
import { audit, type AuditActor } from '../../infra/audit';
import { idempotent, requestHash } from '../../infra/idempotency';
import { featureEnabled, type TenantAccess } from '../../tenancy/access';
import { readiness } from '../onboarding/service';
import { normalizeSnapshot } from '../storefront/service';
import { readBrand, writeBrand } from './brand';
import { readDraftPages, readDraftSnapshot, readLayout } from './drafts';
import { validateDraft } from './service';
import { validateBlocks } from '@/shared/builder/blocks';
import type { SiteSnapshot } from '@/shared/builder/storefront';

type PublishResult = { version_id: string; version_number: number; published_at: string; first_publish: boolean; replayed?: boolean };

async function insertVersion(trx: Tx, access: TenantAccess, actor: AuditActor, snapshot: SiteSnapshot, opts: { note?: string | null; restoredFrom?: string | null }) {
  if (!actor.userId) throw Errors.unauthenticated();
  const next = await trx.selectFrom('site_versions').select(sql<number>`coalesce(max(version_number), 0)::int + 1`.as('n')).where('tenant_id', '=', access.tenantId).executeTakeFirstOrThrow();
  const v = await trx.insertInto('site_versions').values({
    tenant_id: access.tenantId, version_number: next.n, snapshot: JSON.stringify(snapshot), schema_version: snapshot.schema_version,
    note: opts.note ?? null, restored_from_version_id: opts.restoredFrom ?? null, published_by: actor.userId,
  }).returning(['id', 'version_number', 'published_at']).executeTakeFirstOrThrow();
  const before = await trx.selectFrom('tenants').select(['status', 'published_version_id']).where('id', '=', access.tenantId).forUpdate().executeTakeFirstOrThrow();
  // The pointer move and the first-publication activation happen in the same transaction as the snapshot.
  await trx.updateTable('tenants').set({
    published_version_id: v.id,
    ...(before.status === 'onboarding' ? { status: 'active' } : {}),
  }).where('id', '=', access.tenantId).execute();
  return { v, firstPublish: before.published_version_id === null, previous: before.published_version_id };
}

/**
 * Publishes the current draft: readiness checklist + full validation, then an
 * immutable site_versions snapshot and the published pointer in ONE
 * transaction. Idempotent per Idempotency-Key.
 */
export async function publish(access: TenantAccess, actor: AuditActor, idempotencyKey: string, input: { note?: string }): Promise<PublishResult> {
  return withTenant(access.tenantId, async (trx) => {
    // One publication at a time per business.
    await sql`select pg_advisory_xact_lock(hashtext(${`publish:${access.tenantId}`}))`.execute(trx);
    const r = await idempotent<PublishResult>(trx, { scope: `tenant:${access.tenantId}`, operation: 'builder.publish', key: idempotencyKey, hash: requestHash(input) }, async () => {
      const ready = await readiness(access);
      if (!ready.ready) throw new AppError(422, 'not_ready', 'Complete the readiness checklist before publishing', { items: ready.items.filter((i) => !i.ok) });
      const { issues, warnings } = await validateDraft(trx, access);
      if (issues.length) throw new AppError(422, 'publish_validation_failed', 'Fix the highlighted problems before publishing', { issues: issues.slice(0, 50) });
      const snapshot = await readDraftSnapshot(trx, access.tenantId);
      const { v, firstPublish, previous } = await insertVersion(trx, access, actor, snapshot, { note: input.note });
      await audit(trx, actor, 'storefront.published', {
        tenantId: access.tenantId, targetType: 'site_version', targetId: v.id,
        data: { version_number: v.version_number, previous_version_id: previous, first_publish: firstPublish, warnings: warnings.length },
      });
      return { status: 201, body: { version_id: v.id, version_number: v.version_number, published_at: v.published_at.toISOString(), first_publish: firstPublish } };
    });
    return { ...r.body, replayed: r.replayed };
  });
}

export async function listVersions(access: TenantAccess) {
  return withTenant(access.tenantId, async (trx) => {
    const live = await trx.selectFrom('tenants').select('published_version_id').where('id', '=', access.tenantId).executeTakeFirstOrThrow();
    const rows = await trx.selectFrom('site_versions as v').leftJoin('users as u', 'u.id', 'v.published_by')
      .select(['v.id', 'v.version_number', 'v.note', 'v.published_at', 'v.restored_from_version_id', 'u.display_name as published_by_name'])
      .where('v.tenant_id', '=', access.tenantId).orderBy('v.version_number', 'desc').limit(100).execute();
    const numbers = new Map(rows.map((r) => [r.id, r.version_number]));
    return rows.map((r) => ({
      ...r, published_at: r.published_at.toISOString(), is_live: r.id === live.published_version_id,
      restored_from_version_number: r.restored_from_version_id ? numbers.get(r.restored_from_version_id) ?? null : null,
    }));
  });
}

async function loadVersion(trx: Tx, tenantId: string, versionId: string) {
  const v = await trx.selectFrom('site_versions').select(['id', 'version_number', 'snapshot']).where('tenant_id', '=', tenantId).where('id', '=', versionId).executeTakeFirst();
  if (!v) throw Errors.notFound('version');
  return { ...v, snapshot: normalizeSnapshot(v.snapshot) };
}

/**
 * Rollback = republish an earlier design as a NEW immutable version. Only the
 * design moves: bookings, orders, inventory and catalog data are untouched
 * (prices are always read live), and the drafts are left as they are.
 */
export async function rollback(access: TenantAccess, actor: AuditActor, versionId: string, idempotencyKey: string): Promise<PublishResult> {
  return withTenant(access.tenantId, async (trx) => {
    await sql`select pg_advisory_xact_lock(hashtext(${`publish:${access.tenantId}`}))`.execute(trx);
    const r = await idempotent<PublishResult>(trx, { scope: `tenant:${access.tenantId}`, operation: 'builder.rollback', key: idempotencyKey, hash: requestHash({ versionId }) }, async () => {
      const target = await loadVersion(trx, access.tenantId, versionId);
      for (const p of target.snapshot.pages) {
        const s = validateBlocks(p.blocks);
        if (s.issues.length) throw new AppError(422, 'publish_validation_failed', 'This version can no longer be published', { issues: s.issues.slice(0, 20) });
      }
      // Plan policy is re-applied: an old version cannot bring back a hidden platform mark.
      const snapshot: SiteSnapshot = { ...target.snapshot, layout: { ...target.snapshot.layout, footer: { ...target.snapshot.layout.footer, show_powered_by: target.snapshot.layout.footer.show_powered_by || !featureEnabled(access, 'feature.remove_powered_by') } } };
      const { v, previous } = await insertVersion(trx, access, actor, snapshot, { note: `rollback to v${target.version_number}`, restoredFrom: target.id });
      await audit(trx, actor, 'storefront.rolled_back', {
        tenantId: access.tenantId, targetType: 'site_version', targetId: v.id,
        data: { restored_from_version_id: target.id, restored_from_version_number: target.version_number, previous_version_id: previous, version_number: v.version_number },
      });
      return { status: 201, body: { version_id: v.id, version_number: v.version_number, published_at: v.published_at.toISOString(), first_publish: false } };
    });
    return { ...r.body, replayed: r.replayed };
  });
}

/**
 * Copies a version back into the drafts WITHOUT publishing. Bumps every draft
 * version so open editors get a conflict instead of silently overwriting it.
 */
export async function restoreToDraft(access: TenantAccess, actor: AuditActor, versionId: string) {
  return withTenant(access.tenantId, async (trx) => {
    const target = await loadVersion(trx, access.tenantId, versionId);
    const snap = target.snapshot;
    const brand = await readBrand(trx, access.tenantId);
    // Keep the current logo if the old one is no longer available.
    const logoOk = snap.brand.logo_asset_id
      ? !!(await trx.selectFrom('assets').select('id').where('tenant_id', '=', access.tenantId).where('id', '=', snap.brand.logo_asset_id).where('status', '=', 'ready').executeTakeFirst())
      : true;
    const nextBrand = { ...snap.brand, logo_asset_id: logoOk ? snap.brand.logo_asset_id : brand.brand.logo_asset_id };
    const brandVersion = await writeBrand(trx, access.tenantId, nextBrand, brand.version, actor.userId);
    const lay = await readLayout(trx, access.tenantId);
    const layout = { ...snap.layout, footer: { ...snap.layout.footer, show_powered_by: snap.layout.footer.show_powered_by || !featureEnabled(access, 'feature.remove_powered_by') } };
    await trx.updateTable('site_drafts').set({ layout: JSON.stringify(layout), version: lay.version + 1, updated_by: actor.userId }).where('tenant_id', '=', access.tenantId).execute();

    const current = await readDraftPages(trx, access.tenantId, { includeArchived: true });
    const byId = new Map(current.map((p) => [p.id, p]));
    let restored = 0;
    const skipped: string[] = [];
    for (const p of snap.pages) {
      const cur = byId.get(p.id);
      if (!cur) { skipped.push(p.id); continue; }
      await trx.updateTable('store_pages').set({
        title_ar: p.title_ar, title_en: p.title_en, show_in_nav: p.show_in_nav, show_in_footer: p.show_in_footer, sort: p.sort,
        ...(cur.kind === 'custom' ? { slug: p.slug, status: 'active' } : {}),
      }).where('tenant_id', '=', access.tenantId).where('id', '=', p.id).execute();
      await trx.updateTable('page_drafts').set({ blocks: JSON.stringify(p.blocks), version: cur.version + 1, updated_by: actor.userId })
        .where('tenant_id', '=', access.tenantId).where('page_id', '=', p.id).execute();
      restored++;
    }
    await audit(trx, actor, 'storefront.draft_restored', { tenantId: access.tenantId, targetType: 'site_version', targetId: target.id, data: { version_number: target.version_number, pages: restored, skipped: skipped.length } });
    return { restored_from_version_number: target.version_number, pages_restored: restored, pages_skipped: skipped.length, brand_version: brandVersion, published: false };
  });
}

// ── Preview tokens ──────────────────────────────────────────────────────────

export async function createPreviewToken(access: TenantAccess, actor: AuditActor, ttlHours: number) {
  if (!actor.userId) throw Errors.unauthenticated();
  const token = newToken(32);
  const expires = new Date(Date.now() + Math.min(ttlHours, 168) * 3_600_000);
  return withTenant(access.tenantId, async (trx) => {
    const r = await trx.insertInto('preview_tokens').values({ tenant_id: access.tenantId, token_hash: hashToken(token, 'preview'), created_by: actor.userId!, expires_at: expires })
      .returning(['id', 'expires_at', 'created_at']).executeTakeFirstOrThrow();
    await audit(trx, actor, 'storefront.preview_token_created', { tenantId: access.tenantId, targetType: 'preview_token', targetId: r.id, data: { ttl_hours: ttlHours } });
    // The raw token is returned once; only its keyed hash is stored.
    return { id: r.id, token, path: `/preview/${token}`, expires_at: r.expires_at.toISOString() };
  });
}

export async function listPreviewTokens(access: TenantAccess) {
  return withTenant(access.tenantId, async (trx) => {
    const rows = await trx.selectFrom('preview_tokens').select(['id', 'created_at', 'expires_at', 'revoked_at']).where('tenant_id', '=', access.tenantId).orderBy('created_at', 'desc').limit(20).execute();
    const now = Date.now();
    return rows.map((r) => ({ id: r.id, created_at: r.created_at.toISOString(), expires_at: r.expires_at.toISOString(), revoked: !!r.revoked_at, active: !r.revoked_at && r.expires_at.getTime() > now }));
  });
}

export async function revokePreviewToken(access: TenantAccess, actor: AuditActor, id: string) {
  return withTenant(access.tenantId, async (trx) => {
    const r = await trx.updateTable('preview_tokens').set({ revoked_at: new Date() }).where('tenant_id', '=', access.tenantId).where('id', '=', id).where('revoked_at', 'is', null).returning('id').executeTakeFirst();
    if (!r) throw Errors.notFound('preview_token');
    await audit(trx, actor, 'storefront.preview_token_revoked', { tenantId: access.tenantId, targetType: 'preview_token', targetId: id });
    return { id, revoked: true };
  });
}

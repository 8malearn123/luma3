import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { withCentral, withSystem, withTenant, type Tx } from '../../db/client';
import { Errors } from '../../http/errors';
import { audit, type AuditActor } from '../../infra/audit';
import { notifyCapability } from '../../infra/notify';
import { storage } from '../../infra/storage';
import type { TenantAccess } from '../../tenancy/access';
import { assertTenantAssets, assetUrl } from '../assets/service';
import { maskIban, normalizeIban, requiredDocKinds, sniffDocument, type DocKind } from './rules';

/**
 * سوق لوما — business side (join request, visibility, verification documents)
 * and LUMA side (review queues, decisions, per-business commission, settings).
 *
 * Decisions are written only in system scope; a DB trigger
 * (app.guard_marketplace_decisions) rejects them from tenant scope.
 */

export const MAX_DOC_BYTES = 8 * 1024 * 1024;

export const MARKETPLACE_DEFAULTS = { require_verification: true, default_commission_bp: 1000 } as const;

/** Platform marketplace settings (singleton row; defaults when absent). */
export async function marketplaceSettings(trx?: Tx): Promise<{ require_verification: boolean; default_commission_bp: number; updated_at: Date | null }> {
  const run = async (t: Tx) => (await t.selectFrom('marketplace_settings').select(['require_verification', 'default_commission_bp', 'updated_at']).executeTakeFirst())
    ?? { ...MARKETPLACE_DEFAULTS, updated_at: null };
  return trx ? run(trx) : withCentral(run);
}

async function listingRow(trx: Tx, tenantId: string) {
  return trx.selectFrom('marketplace_listings').selectAll().where('tenant_id', '=', tenantId).executeTakeFirst();
}
async function verificationRow(trx: Tx, tenantId: string) {
  return trx.selectFrom('tenant_verifications').selectAll().where('tenant_id', '=', tenantId).executeTakeFirst();
}
async function currentDocs(trx: Tx, tenantId: string) {
  return trx.selectFrom('verification_documents').select(['id', 'kind', 'mime', 'bytes', 'file_name', 'iban', 'created_at'])
    .where('tenant_id', '=', tenantId).where('superseded_at', 'is', null).orderBy('created_at').execute();
}

/** Why a business is not visible in the marketplace right now (empty = visible). */
function blockers(t: { status: string; published_version_id: string | null }, l: { status: string; hidden: boolean } | undefined, verified: boolean, requireVerification: boolean) {
  const out: string[] = [];
  if (!l || l.status !== 'approved') out.push('not_approved');
  if (l?.hidden) out.push('hidden');
  if (t.status !== 'active') out.push('not_active');
  if (!t.published_version_id) out.push('not_published');
  if (requireVerification && !verified) out.push('not_verified');
  return out;
}

// ── Business side ───────────────────────────────────────────────────────────
export async function marketplaceStatus(access: TenantAccess) {
  return withTenant(access.tenantId, async (trx) => {
    const settings = await marketplaceSettings(trx);
    const t = await trx.selectFrom('tenants').select(['status', 'published_version_id', 'business_type']).where('id', '=', access.tenantId).executeTakeFirstOrThrow();
    const l = await listingRow(trx, access.tenantId);
    const v = await verificationRow(trx, access.tenantId);
    const docs = await currentDocs(trx, access.tenantId);
    const verified = v?.status === 'verified';
    const required = requiredDocKinds(t.business_type);
    return {
      listing: {
        status: l?.status ?? 'draft', hidden: l?.hidden ?? false, tagline_ar: l?.tagline_ar ?? null, tagline_en: l?.tagline_en ?? null,
        cover_asset_id: l?.cover_asset_id ?? null, cover_url: l?.cover_asset_id ? assetUrl(l.cover_asset_id) : null,
        requested_at: l?.requested_at ?? null, reviewed_at: l?.reviewed_at ?? null, rejection_reason: l?.rejection_reason ?? null, version: l?.version ?? 0,
        commission_bp: l?.commission_bp ?? settings.default_commission_bp, commission_is_default: l?.commission_bp == null,
      },
      visible: blockers(t, l, verified, settings.require_verification).length === 0,
      blockers: blockers(t, l, verified, settings.require_verification),
      verification: {
        status: v?.status ?? 'draft', submitted_at: v?.submitted_at ?? null, reviewed_at: v?.reviewed_at ?? null, verified_at: v?.verified_at ?? null,
        rejection_reason: v?.rejection_reason ?? null, required, missing: required.filter((k) => !docs.some((d) => d.kind === k)),
        documents: docs.map((d) => ({ id: d.id, kind: d.kind, mime: d.mime, bytes: d.bytes, file_name: d.file_name, iban_masked: maskIban(d.iban), created_at: d.created_at })),
      },
      settings: { require_verification: settings.require_verification },
    };
  });
}

/** Business asks to appear in the marketplace (again after a rejection). */
export async function requestListing(access: TenantAccess, actor: AuditActor) {
  await withTenant(access.tenantId, async (trx) => {
    const settings = await marketplaceSettings(trx);
    const t = await trx.selectFrom('tenants').select(['status', 'published_version_id']).where('id', '=', access.tenantId).executeTakeFirstOrThrow();
    if (!t.published_version_id) throw Errors.conflict('storefront_not_published', 'Publish your storefront before joining the marketplace');
    if (t.status !== 'active') throw Errors.conflict('business_not_active', 'The business must be active');
    if (settings.require_verification) {
      const v = await verificationRow(trx, access.tenantId);
      if (v?.status !== 'verified') throw Errors.conflict('verification_required', 'Verify your business before joining the marketplace');
    }
    const l = await trx.selectFrom('marketplace_listings').select(['status']).where('tenant_id', '=', access.tenantId).forUpdate().executeTakeFirst();
    if (l?.status === 'pending') throw Errors.conflict('already_requested', 'Your request is under review');
    if (l?.status === 'approved') throw Errors.conflict('already_listed', 'Your business is already in the marketplace');
    const now = new Date();
    if (l) await trx.updateTable('marketplace_listings').set({ status: 'pending', requested_at: now, requested_by: actor.userId, version: (e) => e('version', '+', 1) }).where('tenant_id', '=', access.tenantId).execute();
    else await trx.insertInto('marketplace_listings').values({ tenant_id: access.tenantId, status: 'pending', requested_at: now, requested_by: actor.userId }).execute();
    await audit(trx, actor, 'marketplace.listing.requested', { tenantId: access.tenantId, targetType: 'tenant', targetId: access.tenantId });
  });
  return marketplaceStatus(access);
}

/** Visibility and the card's own text/cover; the business can hide itself at any time. */
export async function updateListing(access: TenantAccess, actor: AuditActor, input: { hidden?: boolean; tagline_ar?: string | null; tagline_en?: string | null; cover_asset_id?: string | null }) {
  await withTenant(access.tenantId, async (trx) => {
    if (input.cover_asset_id) {
      await assertTenantAssets(trx, access.tenantId, [input.cover_asset_id]);
      const a = await trx.selectFrom('assets').select('visibility').where('id', '=', input.cover_asset_id).executeTakeFirstOrThrow();
      if (a.visibility !== 'public') throw Errors.invalid('invalid_asset');
    }
    const patch: Record<string, unknown> = {};
    for (const k of ['hidden', 'tagline_ar', 'tagline_en', 'cover_asset_id'] as const) if (input[k] !== undefined) patch[k] = typeof input[k] === 'string' ? (input[k] as string).trim() || null : input[k];
    const l = await listingRow(trx, access.tenantId);
    if (l) await trx.updateTable('marketplace_listings').set({ ...patch, version: l.version + 1 }).where('tenant_id', '=', access.tenantId).execute();
    else await trx.insertInto('marketplace_listings').values({ tenant_id: access.tenantId, ...patch }).execute();
    await audit(trx, actor, input.hidden === true ? 'marketplace.listing.hidden' : input.hidden === false ? 'marketplace.listing.shown' : 'marketplace.listing.updated', { tenantId: access.tenantId, targetType: 'tenant', targetId: access.tenantId, data: patch });
  });
  return marketplaceStatus(access);
}

/**
 * Uploads one verification document (PDF or image; images are re-encoded to
 * WebP, dropping metadata). Stored privately; the previous document of the same
 * kind is superseded. Not possible while a review is pending or once verified.
 */
export async function uploadVerificationDocument(access: TenantAccess, actor: AuditActor, input: { kind: DocKind; data: Buffer; fileName?: string | null; iban?: string | null }) {
  if (!input.data.length) throw Errors.invalid('empty_file');
  if (input.data.length > MAX_DOC_BYTES) throw Errors.invalid('file_too_large', 'Maximum 8 MB');
  if (!requiredDocKinds(access.businessType).includes(input.kind)) throw Errors.invalid('document_not_required', 'This document is not required for your business type');
  let iban: string | null = null;
  if (input.kind === 'iban') {
    iban = normalizeIban(input.iban ?? '');
    if (!iban) throw Errors.invalid('invalid_iban', 'Enter a valid IBAN');
  }
  const type = sniffDocument(input.data);
  if (!type) throw Errors.invalid('unsupported_file', 'Use PDF, JPEG, PNG, WebP or HEIC');
  let data = input.data;
  let mime: 'application/pdf' | 'image/webp' = 'application/pdf';
  if (type === 'image') {
    try {
      data = await sharp(input.data, { limitInputPixels: 40_000_000, animated: false }).rotate().resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true }).webp({ quality: 85 }).toBuffer();
    } catch {
      throw Errors.invalid('unsupported_file', 'The file is not a supported image');
    }
    mime = 'image/webp';
  }
  const id = randomUUID();
  const key = `tenants/${access.tenantId}/verification/${id}.${mime === 'image/webp' ? 'webp' : 'pdf'}`;
  await storage().put(key, data, mime);
  try {
    await withTenant(access.tenantId, async (trx) => {
      const v = await trx.selectFrom('tenant_verifications').select(['status']).where('tenant_id', '=', access.tenantId).forUpdate().executeTakeFirst();
      if (v?.status === 'pending') throw Errors.conflict('verification_under_review', 'Your documents are under review');
      if (v?.status === 'verified') throw Errors.conflict('already_verified', 'Your business is already verified');
      await trx.updateTable('verification_documents').set({ superseded_at: new Date() }).where('tenant_id', '=', access.tenantId).where('kind', '=', input.kind).where('superseded_at', 'is', null).execute();
      await trx.insertInto('verification_documents').values({
        id, tenant_id: access.tenantId, kind: input.kind, storage_key: key, mime, bytes: data.length,
        sha256: createHash('sha256').update(data).digest('hex'), file_name: input.fileName?.slice(0, 160) || null, iban, uploaded_by: actor.userId,
      }).execute();
      if (!v) await trx.insertInto('tenant_verifications').values({ tenant_id: access.tenantId, status: 'draft' }).execute();
      await audit(trx, actor, 'marketplace.verification.document_uploaded', { tenantId: access.tenantId, targetType: 'verification_document', targetId: id, data: { kind: input.kind, bytes: data.length, mime } });
    });
  } catch (err) {
    await storage().delete(key);
    throw err;
  }
  return marketplaceStatus(access);
}

export async function submitVerification(access: TenantAccess, actor: AuditActor) {
  await withTenant(access.tenantId, async (trx) => {
    const v = await trx.selectFrom('tenant_verifications').select(['status', 'version']).where('tenant_id', '=', access.tenantId).forUpdate().executeTakeFirst();
    if (v?.status === 'pending') throw Errors.conflict('verification_under_review', 'Your documents are under review');
    if (v?.status === 'verified') throw Errors.conflict('already_verified', 'Your business is already verified');
    const docs = await currentDocs(trx, access.tenantId);
    const missing = requiredDocKinds(access.businessType).filter((k) => !docs.some((d) => d.kind === k));
    if (missing.length) throw Errors.invalid('documents_missing', 'Upload every required document first', { missing });
    const now = new Date();
    if (v) await trx.updateTable('tenant_verifications').set({ status: 'pending', submitted_at: now, submitted_by: actor.userId, version: v.version + 1 }).where('tenant_id', '=', access.tenantId).execute();
    else await trx.insertInto('tenant_verifications').values({ tenant_id: access.tenantId, status: 'pending', submitted_at: now, submitted_by: actor.userId }).execute();
    await audit(trx, actor, 'marketplace.verification.submitted', { tenantId: access.tenantId, targetType: 'tenant', targetId: access.tenantId });
  });
  return marketplaceStatus(access);
}

async function readDocument(trx: Tx, tenantId: string | null, docId: string) {
  let q = trx.selectFrom('verification_documents').select(['id', 'tenant_id', 'kind', 'storage_key', 'mime']).where('id', '=', docId);
  if (tenantId) q = q.where('tenant_id', '=', tenantId);
  const d = await q.executeTakeFirst();
  if (!d) throw Errors.notFound('document');
  return d;
}

export function documentResponse(d: { id: string; kind: string; mime: string }, data: Buffer) {
  return new Response(new Uint8Array(data), {
    headers: {
      'Content-Type': d.mime, 'Content-Length': String(data.length), 'Cache-Control': 'private, no-store',
      'Content-Disposition': `${d.mime === 'application/pdf' ? 'attachment' : 'inline'}; filename="luma-${d.kind}-${d.id.slice(0, 8)}.${d.mime === 'application/pdf' ? 'pdf' : 'webp'}"`,
      'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox",
    },
  });
}

/** The owner downloads her own document (tenant scope). */
export async function tenantDocumentFile(access: TenantAccess, docId: string) {
  const d = await withTenant(access.tenantId, (trx) => readDocument(trx, access.tenantId, docId));
  const data = await storage().get(d.storage_key);
  if (!data) throw Errors.notFound('document');
  return documentResponse(d, data);
}

// ── LUMA side ───────────────────────────────────────────────────────────────
const TENANT_BRIEF = ['t.id as tenant_id', 't.slug', 't.name', 't.business_type', 't.city', 't.status as tenant_status'] as const;

export async function listListingRequests(f: { status?: string }) {
  return withSystem('platform: marketplace listing queue', async (trx) => {
    let q = trx.selectFrom('marketplace_listings as l').innerJoin('tenants as t', 't.id', 'l.tenant_id')
      .leftJoin('tenant_verifications as v', 'v.tenant_id', 'l.tenant_id')
      .select([...TENANT_BRIEF, 'l.status', 'l.hidden', 'l.requested_at', 'l.reviewed_at', 'l.rejection_reason', 'l.commission_bp', 'v.status as verification_status', (eb) => eb.ref('t.published_version_id').as('published_version_id')]);
    if (f.status) q = q.where('l.status', '=', f.status);
    else q = q.where('l.status', '<>', 'draft');
    const rows = await q.orderBy('l.requested_at', 'desc').limit(200).execute();
    return rows.map(({ published_version_id, ...r }) => ({ ...r, slug: String(r.slug), published: !!published_version_id }));
  });
}

export async function reviewListing(tenantId: string, actor: AuditActor, input: { decision: 'approve' | 'reject'; reason?: string | null }) {
  return withSystem('platform: marketplace listing decision', async (trx) => {
    const l = await trx.selectFrom('marketplace_listings').select(['status', 'version']).where('tenant_id', '=', tenantId).forUpdate().executeTakeFirst();
    if (!l) throw Errors.notFound('listing');
    if (l.status !== 'pending') throw Errors.conflict('invalid_transition', 'Only a pending request can be reviewed', { status: l.status });
    const t = await trx.selectFrom('tenants').select(['slug', 'status', 'published_version_id']).where('id', '=', tenantId).executeTakeFirstOrThrow();
    const now = new Date();
    if (input.decision === 'approve') {
      const settings = await marketplaceSettings(trx);
      if (settings.require_verification) {
        const v = await verificationRow(trx, tenantId);
        if (v?.status !== 'verified') throw Errors.conflict('verification_required', 'The business must be verified first');
      }
      await trx.updateTable('marketplace_listings').set({ status: 'approved', approved_at: now, reviewed_at: now, reviewed_by: actor.userId, rejection_reason: null, version: l.version + 1 }).where('tenant_id', '=', tenantId).execute();
    } else {
      const reason = input.reason?.trim();
      if (!reason || reason.length < 3) throw Errors.invalid('reason_required', 'Please give a reason');
      await trx.updateTable('marketplace_listings').set({ status: 'rejected', reviewed_at: now, reviewed_by: actor.userId, rejection_reason: reason, version: l.version + 1 }).where('tenant_id', '=', tenantId).execute();
    }
    await audit(trx, actor, `platform.marketplace.listing_${input.decision === 'approve' ? 'approved' : 'rejected'}`, { tenantId, targetType: 'tenant', targetId: tenantId, data: { reason: input.reason ?? null } });
    await notifyCapability(trx, tenantId, ['business.manage'], {
      kind: 'marketplace.listing_decision',
      title_ar: input.decision === 'approve' ? 'تمت الموافقة على ظهور نشاطك في سوق لوما 🎉' : 'لم تتم الموافقة على طلب الظهور في سوق لوما',
      title_en: input.decision === 'approve' ? 'Your business is now in the LUMA marketplace' : 'Your LUMA marketplace request was not approved',
      body_ar: input.decision === 'reject' ? input.reason ?? undefined : undefined, body_en: input.decision === 'reject' ? input.reason ?? undefined : undefined,
      target_path: `/app/${String(t.slug)}/settings?tab=marketplace`,
    });
    return { tenant_id: tenantId, status: input.decision === 'approve' ? 'approved' : 'rejected' };
  });
}

export async function listVerifications(f: { status?: string }) {
  return withSystem('platform: verification queue', async (trx) => {
    let q = trx.selectFrom('tenant_verifications as v').innerJoin('tenants as t', 't.id', 'v.tenant_id')
      .select([...TENANT_BRIEF, 'v.status', 'v.submitted_at', 'v.reviewed_at', 'v.verified_at', 'v.rejection_reason']);
    q = f.status ? q.where('v.status', '=', f.status) : q.where('v.status', '<>', 'draft');
    const rows = await q.orderBy('v.submitted_at', 'desc').limit(200).execute();
    return rows.map((r) => ({ ...r, slug: String(r.slug) }));
  });
}

/** Full verification file for a reviewer, including the IBAN (platform reviewers only). */
export async function verificationDetail(tenantId: string) {
  return withSystem('platform: verification detail', async (trx) => {
    const t = await trx.selectFrom('tenants as t').select([...TENANT_BRIEF]).where('t.id', '=', tenantId).executeTakeFirst();
    if (!t) throw Errors.notFound('business');
    const v = await verificationRow(trx, tenantId);
    const docs = await currentDocs(trx, tenantId);
    const required = requiredDocKinds(t.business_type);
    const legal = await trx.selectFrom('tenant_settings').select(['legal_name', 'tax_number']).where('tenant_id', '=', tenantId).executeTakeFirst();
    return {
      tenant: { ...t, slug: String(t.slug) }, legal: legal ?? null,
      verification: { status: v?.status ?? 'draft', submitted_at: v?.submitted_at ?? null, reviewed_at: v?.reviewed_at ?? null, verified_at: v?.verified_at ?? null, rejection_reason: v?.rejection_reason ?? null },
      required, missing: required.filter((k) => !docs.some((d) => d.kind === k)),
      documents: docs.map((d) => ({ id: d.id, kind: d.kind, mime: d.mime, bytes: d.bytes, file_name: d.file_name, iban: d.iban, created_at: d.created_at })),
    };
  });
}

export async function platformDocumentFile(docId: string, actor: AuditActor) {
  const d = await withSystem('platform: read verification document', async (trx) => {
    const doc = await readDocument(trx, null, docId);
    await audit(trx, actor, 'platform.marketplace.document_viewed', { tenantId: doc.tenant_id, targetType: 'verification_document', targetId: doc.id, data: { kind: doc.kind } });
    return doc;
  });
  const data = await storage().get(d.storage_key);
  if (!data) throw Errors.notFound('document');
  return documentResponse(d, data);
}

export async function reviewVerification(tenantId: string, actor: AuditActor, input: { decision: 'approve' | 'reject'; reason?: string | null }) {
  return withSystem('platform: verification decision', async (trx) => {
    const v = await trx.selectFrom('tenant_verifications').select(['status', 'version']).where('tenant_id', '=', tenantId).forUpdate().executeTakeFirst();
    if (!v) throw Errors.notFound('verification');
    if (v.status !== 'pending') throw Errors.conflict('invalid_transition', 'Only a pending verification can be reviewed', { status: v.status });
    const t = await trx.selectFrom('tenants').select(['slug', 'business_type']).where('id', '=', tenantId).executeTakeFirstOrThrow();
    const now = new Date();
    if (input.decision === 'approve') {
      const docs = await currentDocs(trx, tenantId);
      const missing = requiredDocKinds(t.business_type).filter((k) => !docs.some((d) => d.kind === k));
      if (missing.length) throw Errors.invalid('documents_missing', 'Required documents are missing', { missing });
      await trx.updateTable('tenant_verifications').set({ status: 'verified', verified_at: now, reviewed_at: now, reviewed_by: actor.userId, rejection_reason: null, version: v.version + 1 }).where('tenant_id', '=', tenantId).execute();
    } else {
      const reason = input.reason?.trim();
      if (!reason || reason.length < 3) throw Errors.invalid('reason_required', 'Please give a reason');
      await trx.updateTable('tenant_verifications').set({ status: 'rejected', reviewed_at: now, reviewed_by: actor.userId, rejection_reason: reason, version: v.version + 1 }).where('tenant_id', '=', tenantId).execute();
    }
    await audit(trx, actor, `platform.marketplace.verification_${input.decision === 'approve' ? 'approved' : 'rejected'}`, { tenantId, targetType: 'tenant', targetId: tenantId, data: { reason: input.reason ?? null } });
    await notifyCapability(trx, tenantId, ['business.manage'], {
      kind: 'marketplace.verification_decision',
      title_ar: input.decision === 'approve' ? 'تم توثيق نشاطك من لوما ✓' : 'لم يكتمل توثيق نشاطك',
      title_en: input.decision === 'approve' ? 'LUMA verified your business' : 'Your business verification was not approved',
      body_ar: input.decision === 'reject' ? input.reason ?? undefined : undefined, body_en: input.decision === 'reject' ? input.reason ?? undefined : undefined,
      target_path: `/app/${String(t.slug)}/settings?tab=marketplace`,
    });
    return { tenant_id: tenantId, status: input.decision === 'approve' ? 'verified' : 'rejected' };
  });
}

/** Per-business commission (basis points); null returns the business to the platform default. */
export async function setCommissionRate(tenantId: string, actor: AuditActor, commissionBp: number | null) {
  return withSystem('platform: marketplace commission rate', async (trx) => {
    const t = await trx.selectFrom('tenants').select('id').where('id', '=', tenantId).executeTakeFirst();
    if (!t) throw Errors.notFound('business');
    const cur = await listingRow(trx, tenantId);
    if (cur) await trx.updateTable('marketplace_listings').set({ commission_bp: commissionBp, version: cur.version + 1 }).where('tenant_id', '=', tenantId).execute();
    else await trx.insertInto('marketplace_listings').values({ tenant_id: tenantId, commission_bp: commissionBp }).execute();
    await audit(trx, actor, 'platform.marketplace.commission_set', { tenantId, targetType: 'tenant', targetId: tenantId, data: { from: cur?.commission_bp ?? null, to: commissionBp } });
    const s = await marketplaceSettings(trx);
    return { tenant_id: tenantId, commission_bp: commissionBp, effective_bp: commissionBp ?? s.default_commission_bp };
  });
}

export async function updateMarketplaceSettings(actor: AuditActor, input: { require_verification?: boolean; default_commission_bp?: number }) {
  return withSystem('platform: marketplace settings', async (trx) => {
    const before = await marketplaceSettings(trx);
    const patch: Record<string, unknown> = { updated_by: actor.userId, updated_at: new Date() };
    if (input.require_verification !== undefined) patch.require_verification = input.require_verification;
    if (input.default_commission_bp !== undefined) patch.default_commission_bp = input.default_commission_bp;
    await trx.insertInto('marketplace_settings').values({ id: true, require_verification: before.require_verification, default_commission_bp: before.default_commission_bp, ...patch })
      .onConflict((oc) => oc.column('id').doUpdateSet(patch)).execute();
    await audit(trx, actor, 'platform.marketplace.settings_updated', { targetType: 'marketplace_settings', data: { before: { require_verification: before.require_verification, default_commission_bp: before.default_commission_bp }, after: input } });
    return marketplaceSettings(trx);
  });
}

/** Marketplace summary for the platform tenant drawer. */
export async function tenantMarketplaceSummary(tenantId: string) {
  return withSystem('platform: tenant marketplace summary', async (trx) => {
    const s = await marketplaceSettings(trx);
    const t = await trx.selectFrom('tenants').select(['status', 'published_version_id']).where('id', '=', tenantId).executeTakeFirst();
    if (!t) throw Errors.notFound('business');
    const l = await listingRow(trx, tenantId);
    const v = await verificationRow(trx, tenantId);
    const fees = await trx.selectFrom('marketplace_commissions').select([(eb) => eb.fn.countAll<number>().as('n'), (eb) => eb.fn.coalesce(eb.fn.sum<number>('fee_minor'), eb.lit(0)).as('fee_minor')])
      .where('tenant_id', '=', tenantId).executeTakeFirstOrThrow();
    return {
      listing_status: l?.status ?? 'draft', hidden: l?.hidden ?? false, verification_status: v?.status ?? 'draft',
      commission_bp: l?.commission_bp ?? null, default_commission_bp: s.default_commission_bp, effective_bp: l?.commission_bp ?? s.default_commission_bp,
      visible: blockers(t, l, v?.status === 'verified', s.require_verification).length === 0,
      fees_total: { bookings: Number(fees.n), fee_minor: Number(fees.fee_minor) },
    };
  });
}

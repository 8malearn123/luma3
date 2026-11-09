import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { z } from 'zod';
import type { Capability } from '../../auth/capabilities';
import { withTenant, type Tx } from '../../db/client';
import { Errors } from '../../http/errors';
import { audit, type AuditActor } from '../../infra/audit';
import { storage } from '../../infra/storage';
import type { TenantAccess } from '../../tenancy/access';
import { hexToRgb, rgbToHex, rgbToHsl } from '@/shared/builder/theme';

export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const ACCEPTED_IMAGE_FORMATS = new Set(['jpeg', 'png', 'webp', 'gif', 'avif', 'heif']);
const PURPOSE_MAX_EDGE: Record<string, number> = { logo: 1024, cover: 2400, gallery: 2000, service: 1600, product: 1600, staff: 1200, block: 2400, evidence: 2400, receipt: 2400 };

export type UploadPurpose = 'logo' | 'cover' | 'gallery' | 'service' | 'product' | 'staff' | 'block' | 'evidence' | 'receipt';

/** Who may upload (or crop) an image for each purpose. */
export const PURPOSE_CAPS: Record<UploadPurpose, Capability[]> = {
  logo: ['builder.edit', 'business.manage'], cover: ['builder.edit', 'business.manage'], gallery: ['builder.edit'], block: ['builder.edit'],
  service: ['catalog.edit'], product: ['catalog.edit'], staff: ['staff.edit', 'staff.edit_own_profile'],
  evidence: ['incidents.submit'], receipt: ['finance.manage'],
};

/** Optional `crop` form field / body: JSON rectangle in source pixels. */
export const cropSchema = z.object({ x: z.number().min(0).max(100_000), y: z.number().min(0).max(100_000), width: z.number().min(1).max(100_000), height: z.number().min(1).max(100_000) }).strict();

/**
 * Validates an uploaded image by decoding its actual content (not the file
 * name or client MIME), re-encodes it to WebP (dropping EXIF/GPS metadata and
 * any embedded active content), bounds its dimensions, and stores it.
 * SVG is rejected because it can carry script.
 */
export type CropRect = { x: number; y: number; width: number; height: number };

/**
 * Clamps a crop rectangle (source pixels, after EXIF orientation) to the image.
 * Returns null when the rectangle is empty or covers the whole image.
 */
export function clampCrop(c: CropRect, w: number, h: number): CropRect | null {
  const x = Math.max(0, Math.min(w - 1, Math.round(c.x)));
  const y = Math.max(0, Math.min(h - 1, Math.round(c.y)));
  const width = Math.max(1, Math.min(w - x, Math.round(c.width)));
  const height = Math.max(1, Math.min(h - y, Math.round(c.height)));
  if (width < 8 || height < 8) throw Errors.invalid('invalid_crop', 'The crop area is too small');
  if (x === 0 && y === 0 && width === w && height === h) return null;
  return { x, y, width, height };
}

/**
 * Validates an uploaded image by decoding its actual content (not the file
 * name or client MIME), re-encodes it to WebP (dropping EXIF/GPS metadata and
 * any embedded active content), bounds its dimensions, and stores it.
 * SVG is rejected because it can carry script. An optional crop (from the
 * crop editor) is applied after EXIF orientation, before resizing, so the
 * stored asset IS the cropped derivative; the rectangle is kept on the row.
 */
export async function uploadImage(access: TenantAccess, actor: AuditActor, input: { data: Buffer; purpose: UploadPurpose; alt_ar?: string; alt_en?: string; crop?: CropRect | null; sourceAssetId?: string | null }) {
  if (input.data.length === 0) throw Errors.invalid('empty_file');
  if (input.data.length > MAX_UPLOAD_BYTES) throw Errors.invalid('file_too_large', `Maximum ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`);
  let meta: sharp.Metadata;
  try {
    meta = await sharp(input.data, { limitInputPixels: 40_000_000 }).metadata();
  } catch {
    throw Errors.invalid('unsupported_file', 'The file is not a supported image');
  }
  if (!meta.format || !ACCEPTED_IMAGE_FORMATS.has(meta.format)) throw Errors.invalid('unsupported_file', 'Use JPEG, PNG, WebP, GIF, AVIF or HEIC');
  const maxEdge = PURPOSE_MAX_EDGE[input.purpose] ?? 2000;
  let source: Buffer = input.data;
  let crop: CropRect | null = null;
  if (input.crop) {
    // Orient first so crop coordinates match what the editor displayed.
    const oriented = await sharp(input.data, { limitInputPixels: 40_000_000, animated: false }).rotate().png({ compressionLevel: 1 }).toBuffer({ resolveWithObject: true });
    crop = clampCrop(input.crop, oriented.info.width, oriented.info.height);
    source = crop
      ? await sharp(oriented.data).extract({ left: crop.x, top: crop.y, width: crop.width, height: crop.height }).png({ compressionLevel: 1 }).toBuffer()
      : oriented.data;
  }
  const out = await sharp(source, { limitInputPixels: 40_000_000, animated: false })
    .rotate() // honour EXIF orientation before metadata is dropped
    .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 82 })
    .toBuffer({ resolveWithObject: true });

  const id = randomUUID();
  const key = `tenants/${access.tenantId}/${id}.webp`;
  await storage().put(key, out.data, 'image/webp');
  const visibility = input.purpose === 'evidence' || input.purpose === 'receipt' ? 'private' : 'public';
  try {
    return await withTenant(access.tenantId, async (trx) => {
      if (input.sourceAssetId) await assertTenantAssets(trx, access.tenantId, [input.sourceAssetId]);
      const row = await trx.insertInto('assets').values({
        id, tenant_id: access.tenantId, kind: input.purpose === 'evidence' ? 'evidence' : 'image', purpose: input.purpose,
        storage_key: key, mime: 'image/webp', bytes: out.data.length, width: out.info.width, height: out.info.height,
        sha256: createHash('sha256').update(out.data).digest('hex'), alt_ar: input.alt_ar ?? null, alt_en: input.alt_en ?? null,
        status: 'ready', visibility, uploaded_by: actor.userId,
        crop: crop ? JSON.stringify(crop) : null, source_asset_id: input.sourceAssetId ?? null,
      }).returning(['id', 'width', 'height', 'bytes', 'mime', 'visibility', 'purpose']).executeTakeFirstOrThrow();
      await audit(trx, actor, 'asset.uploaded', { tenantId: access.tenantId, targetType: 'asset', targetId: id, data: { purpose: input.purpose, bytes: out.data.length, crop, source_asset_id: input.sourceAssetId ?? null } });
      return { ...row, crop, url: assetUrl(id) };
    });
  } catch (err) {
    await storage().delete(key);
    throw err;
  }
}

/** Re-crops an existing image into a new derived asset (the original stays untouched). */
export async function cropExistingAsset(access: TenantAccess, actor: AuditActor, assetId: string, crop: CropRect, purpose?: UploadPurpose) {
  const asset = await withTenant(access.tenantId, (trx) => trx.selectFrom('assets').select(['storage_key', 'purpose', 'kind', 'alt_ar', 'alt_en'])
    .where('id', '=', assetId).where('status', '=', 'ready').executeTakeFirst());
  if (!asset || asset.kind !== 'image') throw Errors.notFound('asset');
  const buf = await storage().get(asset.storage_key);
  if (!buf) throw Errors.notFound('asset');
  return uploadImage(access, actor, {
    data: buf, purpose: purpose ?? (asset.purpose as UploadPurpose), alt_ar: asset.alt_ar ?? undefined, alt_en: asset.alt_en ?? undefined, crop, sourceAssetId: assetId,
  });
}

export function assetUrl(id: string) {
  return `/api/v1/media/${id}`;
}

/** Ensures every referenced asset belongs to this tenant and is ready. */
export async function assertTenantAssets(trx: Tx, tenantId: string, ids: Iterable<string>) {
  const list = [...new Set(ids)].filter(Boolean);
  if (!list.length) return;
  const rows = await trx.selectFrom('assets').select('id').where('tenant_id', '=', tenantId).where('id', 'in', list).where('status', '=', 'ready').execute();
  if (rows.length !== list.length) throw Errors.invalid('invalid_asset', 'An image is missing or belongs to another business');
}

export async function updateAlt(access: TenantAccess, assetId: string, alt: { alt_ar?: string | null; alt_en?: string | null }) {
  return withTenant(access.tenantId, async (trx) => {
    const r = await trx.updateTable('assets').set({ alt_ar: alt.alt_ar ?? null, alt_en: alt.alt_en ?? null })
      .where('id', '=', assetId).where('status', '=', 'ready').returning('id').executeTakeFirst();
    if (!r) throw Errors.notFound('asset');
    return r;
  });
}

export async function deleteAsset(access: TenantAccess, actor: AuditActor, assetId: string) {
  return withTenant(access.tenantId, async (trx) => {
    const r = await trx.updateTable('assets').set({ status: 'deleted' }).where('id', '=', assetId).where('status', '=', 'ready')
      .returning('storage_key').executeTakeFirst();
    if (!r) throw Errors.notFound('asset');
    await audit(trx, actor, 'asset.deleted', { tenantId: access.tenantId, targetType: 'asset', targetId: assetId });
    // Physical deletion happens after published versions stop referencing it (retention job).
    return { deleted: true };
  });
}

/**
 * Dominant colours of a logo for palette *suggestions* (owner must accept).
 * Ignores transparent, near-white and near-black pixels; buckets by hue.
 */
export async function dominantColors(access: TenantAccess, assetId: string, max = 3): Promise<string[]> {
  const asset = await withTenant(access.tenantId, (trx) => trx.selectFrom('assets').select('storage_key').where('id', '=', assetId).where('status', '=', 'ready').executeTakeFirst());
  if (!asset) throw Errors.notFound('asset');
  const buf = await storage().get(asset.storage_key);
  if (!buf) throw Errors.notFound('asset');
  const { data, info } = await sharp(buf).resize(64, 64, { fit: 'inside' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
  for (let i = 0; i < data.length; i += info.channels) {
    const [r, g, b, a] = [data[i]!, data[i + 1]!, data[i + 2]!, data[i + 3]!];
    if (a < 128) continue;
    const [h, s, l] = rgbToHsl([r, g, b]);
    if (l > 0.93 || l < 0.06 || s < 0.08) continue;
    const key = Math.round(h / 20) * 10 + Math.round(l * 4);
    const bk = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    bk.n++; bk.r += r; bk.g += g; bk.b += b;
    buckets.set(key, bk);
  }
  return [...buckets.values()].sort((a, b) => b.n - a.n).slice(0, max)
    .map((bk) => rgbToHex([bk.r / bk.n, bk.g / bk.n, bk.b / bk.n]))
    .filter((c, i, arr) => arr.findIndex((x) => Math.abs(hexToRgb(x)[0] - hexToRgb(c)[0]) < 8) === i);
}

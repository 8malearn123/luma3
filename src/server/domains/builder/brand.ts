import type { Tx } from '../../db/client';
import { Errors } from '../../http/errors';
import { NEUTRAL_BRAND, zBrand, type Brand } from '@/shared/builder/theme';
import { assertTenantAssets } from '../assets/service';

/** Reads the draft brand (the single source of truth for theme tokens). */
export async function readBrand(trx: Tx, tenantId: string): Promise<{ brand: Brand; version: number; pending_palette: unknown; brand_character: unknown }> {
  const r = await trx.selectFrom('brand_settings').selectAll().where('tenant_id', '=', tenantId).executeTakeFirst();
  if (!r) return { brand: NEUTRAL_BRAND, version: 0, pending_palette: null, brand_character: {} };
  const parsed = zBrand.safeParse({
    colors: r.colors, fonts: r.fonts, radius: r.radius, button_style: r.button_style, card_style: r.card_style, density: r.density,
    spacing_scale: Number(r.spacing_scale), logo_asset_id: r.logo_asset_id, wordmark_text: r.wordmark_text, tagline_ar: r.tagline_ar, tagline_en: r.tagline_en,
  });
  // Corrupt/legacy values fall back per token instead of breaking the storefront.
  const brand = parsed.success ? parsed.data : { ...NEUTRAL_BRAND, logo_asset_id: r.logo_asset_id, wordmark_text: r.wordmark_text };
  return { brand, version: r.version, pending_palette: r.pending_palette, brand_character: r.brand_character };
}

/** Writes the brand with optimistic concurrency; returns the new version. */
export async function writeBrand(trx: Tx, tenantId: string, brand: Brand, expectedVersion: number, userId: string | null, extra: { brand_character?: unknown; clear_pending_palette?: boolean } = {}) {
  const valid = zBrand.parse(brand);
  if (valid.logo_asset_id) await assertTenantAssets(trx, tenantId, [valid.logo_asset_id]);
  const r = await trx.updateTable('brand_settings').set({
    colors: JSON.stringify(valid.colors), fonts: JSON.stringify(valid.fonts), radius: valid.radius, button_style: valid.button_style,
    card_style: valid.card_style, density: valid.density, spacing_scale: valid.spacing_scale, logo_asset_id: valid.logo_asset_id,
    wordmark_text: valid.wordmark_text, tagline_ar: valid.tagline_ar, tagline_en: valid.tagline_en,
    version: expectedVersion + 1, updated_by: userId,
    ...(extra.brand_character !== undefined ? { brand_character: JSON.stringify(extra.brand_character) } : {}),
    ...(extra.clear_pending_palette ? { pending_palette: null } : {}),
  }).where('tenant_id', '=', tenantId).where('version', '=', expectedVersion).returning('version').executeTakeFirst();
  if (!r) {
    const cur = await trx.selectFrom('brand_settings').select('version').where('tenant_id', '=', tenantId).executeTakeFirst();
    throw Errors.versionConflict(cur?.version);
  }
  return r.version;
}

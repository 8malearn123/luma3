import { randomUUID } from 'node:crypto';
import { IANAZone } from 'luxon';
import { z } from 'zod';
import { audit, Errors, withSystem, withTenant, type AuditActor } from '../db';
import { loomAudit } from '../hosts';
import { requestAnalysis } from '../analysis/run';
import { readPlatformSettings } from '../settings/platform';
import { registeredSectorPacks, sectorPack } from '../sector/packs';
import { render, type LoomLocale } from '../util/text';

/**
 * Loom-side business registry (loom.businesses).
 *
 *  - LUMA tenants: an optional row (host 'luma', id = tenant id) holding the
 *    chosen sector pack; without a row the connector's sector is used.
 *  - External businesses (host 'external'): Loom-only businesses with no LUMA
 *    tenant tables at all. Their id is the RLS scope id (withTenant(id) sets
 *    app.tenant_id; every loom table checks business_id against it). They
 *    are created and operated by the platform owner in /platform/loom
 *    (self-serve auth for external users is not built yet, docs/LOOM_CORE.md §11).
 *
 * A sector pack can only be chosen when the platform enabled it.
 */
const tz = z.string().min(3).max(64).refine((x) => IANAZone.isValidZone(x), { message: 'invalid timezone' });
export const externalBusinessInput = z.object({
  name: z.string().trim().min(2).max(160),
  sector_pack: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/),
  timezone: tz.default('Asia/Riyadh'),
  currency: z.string().regex(/^[A-Z]{3}$/).default('SAR'),
  city: z.string().trim().max(80).optional(),
  locale: z.enum(['ar', 'en']).default('ar'),
}).strict();
export const externalBusinessPatch = externalBusinessInput.partial().extend({ status: z.enum(['active', 'suspended']).optional() }).strict()
  .refine((x) => Object.keys(x).length > 0, { message: 'empty patch' });
export const sectorPackInput = z.object({ sector_pack: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/) }).strict();

async function enabledPacks() {
  return (await withSystem('loom: enabled sector packs', (trx) => readPlatformSettings(trx))).enabled_sector_packs as string[];
}

async function requireEnabled(pack: string) {
  if (!registeredSectorPacks().includes(pack)) throw Errors.invalid('unknown_sector_pack', `Unknown sector pack: ${pack}`);
  if (!(await enabledPacks()).includes(pack)) throw Errors.invalid('sector_pack_disabled', 'This sector pack is not enabled by the platform');
}

export async function packChoices(locale: LoomLocale) {
  const enabled = await enabledPacks();
  return registeredSectorPacks().map((id) => {
    const p = sectorPack(id);
    return { id, label: render(p.label ?? { ar: id, en: id }, locale), version: p.version, enabled: enabled.includes(id),
      vocabulary: Object.fromEntries(Object.entries(p.vocabulary).map(([k, v]) => [k, render(v, locale)])) };
  });
}

// ── LUMA tenants: sector pack choice ────────────────────────────────────────
export async function getSectorPack(c: { businessId: string; locale: LoomLocale }) {
  const row = await withTenant(c.businessId, (trx) => trx.selectFrom('loom.businesses').select(['sector_pack', 'host']).where('id', '=', c.businessId).executeTakeFirst());
  const current = row?.sector_pack ?? 'beauty';
  const p = sectorPack(current);
  return { current, explicit: !!row, vocabulary: Object.fromEntries(Object.entries(p.vocabulary).map(([k, v]) => [k, render(v, c.locale)])), packs: await packChoices(c.locale) };
}

export async function setSectorPack(c: { businessId: string; actor: AuditActor; locale: LoomLocale; name: string }, packId: string) {
  await requireEnabled(packId);
  await withTenant(c.businessId, async (trx) => {
    const cur = await trx.selectFrom('loom.businesses').select(['host', 'sector_pack']).where('id', '=', c.businessId).executeTakeFirst();
    if (cur) await trx.updateTable('loom.businesses').set({ sector_pack: packId }).where('id', '=', c.businessId).execute();
    else await trx.insertInto('loom.businesses').values({ id: c.businessId, host: 'luma', name: c.name.slice(0, 160) || 'LUMA', sector_pack: packId }).execute();
    await loomAudit(trx, c.actor, 'loom.sector_pack_changed', c.businessId, { data: { before: cur?.sector_pack ?? null, after: packId } });
  });
  return getSectorPack(c);
}

// ── External businesses (platform owner) ────────────────────────────────────
type BizRow = { id: string; host: string; name: string; sector_pack: string; timezone: string; currency: string; city: string | null; locale: string; status: string; created_at: Date };
const view = (b: BizRow) => ({ id: b.id, name: b.name, sector_pack: b.sector_pack, timezone: b.timezone, currency: b.currency, city: b.city, locale: b.locale, status: b.status, created_at: b.created_at });

/** Resolves an external business id from untrusted input (system lookup); 404 for anything else, including LUMA tenants. */
export async function resolveExternal(id: string): Promise<string> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw Errors.notFound('business');
  const row = await withSystem('loom: resolve external business', (trx) => trx.selectFrom('loom.businesses').select(['id', 'host']).where('id', '=', id).executeTakeFirst());
  if (!row || row.host !== 'external') throw Errors.notFound('business');
  return row.id;
}

export async function createExternal(actor: AuditActor, input: z.infer<typeof externalBusinessInput>) {
  await requireEnabled(input.sector_pack);
  const id = randomUUID();
  const row = await withTenant(id, async (trx) => {
    const b = await trx.insertInto('loom.businesses').values({ id, host: 'external', name: input.name, sector_pack: input.sector_pack, timezone: input.timezone, currency: input.currency, city: input.city ?? null, locale: input.locale, created_by: actor.userId })
      .returningAll().executeTakeFirstOrThrow();
    await loomAudit(trx, actor, 'loom.external_business_created', id, { data: { name: input.name, sector_pack: input.sector_pack } });
    return b as BizRow;
  });
  await withSystem('loom: platform audit', (trx) => audit(trx, actor, 'loom.external_business_created', { targetType: 'loom_business', targetId: id, data: { sector_pack: input.sector_pack } }));
  return view(row);
}

export async function listExternal() {
  return withSystem('loom: platform list of external businesses', async (trx) => {
    const rows = await trx.selectFrom('loom.businesses').selectAll().where('host', '=', 'external').orderBy('created_at', 'desc').limit(200).execute();
    const out = [];
    for (const b of rows as BizRow[]) {
      const conns = await trx.selectFrom('loom.connections').select(['id', 'kind', 'status', 'review_status', 'primary_source', 'last_sync_at']).where('business_id', '=', b.id).execute();
      const last = await trx.selectFrom('loom.analyses').select(['id', 'status', 'error_code', 'finished_at']).where('business_id', '=', b.id).orderBy('created_at', 'desc').limit(1).executeTakeFirst();
      out.push({ ...view(b), connections: conns, last_analysis: last ?? null });
    }
    return out;
  });
}

export async function getExternal(id: string) {
  return withTenant(id, async (trx) => view(await trx.selectFrom('loom.businesses').selectAll().where('id', '=', id).executeTakeFirstOrThrow() as BizRow));
}

export async function updateExternal(actor: AuditActor, id: string, patch: z.infer<typeof externalBusinessPatch>) {
  if (patch.sector_pack) await requireEnabled(patch.sector_pack);
  const row = await withTenant(id, async (trx) => {
    const b = await trx.updateTable('loom.businesses').set({ ...patch }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
    await loomAudit(trx, actor, 'loom.external_business_updated', id, { data: { fields: Object.keys(patch) } });
    return b as BizRow;
  });
  return view(row);
}

/** Starts an analysis of an external business (platform owner). The review gate is enforced by the analysis itself. */
export async function startExternalAnalysis(actor: AuditActor, id: string) {
  const r = await requestAnalysis(id, { trigger: 'manual', requestedBy: actor.userId });
  await withTenant(id, (trx) => loomAudit(trx, actor, 'loom.analysis_requested', id, { targetType: 'loom_analysis', targetId: r.analysis.id, data: { created: r.created } }));
  return { job_id: r.analysis.id, status: r.analysis.status, created: r.created };
}

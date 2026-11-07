import { withCentral, withSystem, type Tx } from '../../db/client';
import { AppError, Errors } from '../../http/errors';
import { audit, type AuditActor } from '../../infra/audit';
import { notifyCapability } from '../../infra/notify';
import {
  PLATFORM_SETTING_DEFAULTS, PLATFORM_SETTINGS_SCHEMA, type PlatformSettingKey, type PlatformSettings,
} from '@/shared/platform-settings';

/**
 * Platform settings (central key/value). Reads are cached per process for a
 * few seconds (maintenance mode is checked on every dashboard request);
 * updates invalidate the local cache immediately. Other instances pick the
 * change up within CACHE_MS.
 */
const CACHE_MS = 5_000;

// Local keyset cursor helpers (route.ts imports this module, so no import back).
const encodeCursor = (v: Record<string, unknown>) => Buffer.from(JSON.stringify(v)).toString('base64url');
function decodeCursor<T>(c: string | undefined): T | null {
  if (!c) return null;
  try { return JSON.parse(Buffer.from(c, 'base64url').toString('utf8')) as T; } catch { throw Errors.invalid('invalid_cursor'); }
}
let cache: { at: number; value: PlatformSettings } | null = null;

export function resetPlatformSettingsCache() {
  cache = null;
}

function parse(rows: Array<{ key: string; value: unknown }>): PlatformSettings {
  const out: Record<string, unknown> = { ...PLATFORM_SETTING_DEFAULTS };
  const shape = PLATFORM_SETTINGS_SCHEMA.shape as Record<string, { safeParse: (v: unknown) => { success: boolean; data?: unknown } }>;
  for (const r of rows) {
    const s = shape[r.key];
    if (!s) continue;
    const p = s.safeParse(r.value);
    if (p.success) out[r.key] = p.data;
  }
  return out as PlatformSettings;
}

export async function readPlatformSettings(trx: Tx): Promise<PlatformSettings> {
  const rows = await trx.selectFrom('platform_settings').select(['key', 'value']).execute();
  return parse(rows);
}

export async function getPlatformSettings(opts: { fresh?: boolean } = {}): Promise<PlatformSettings> {
  if (!opts.fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const value = await withCentral((trx) => readPlatformSettings(trx));
  cache = { at: Date.now(), value };
  return value;
}

/** Single-key read for other domains, e.g. getPlatformSetting('marketplace_requires_verification'). */
export async function getPlatformSetting<K extends PlatformSettingKey>(key: K): Promise<PlatformSettings[K]> {
  return (await getPlatformSettings())[key];
}

export async function platformSettingsDetail() {
  return withCentral(async (trx) => {
    const rows = await trx.selectFrom('platform_settings as s').leftJoin('users as u', 'u.id', 's.updated_by')
      .select(['s.key', 's.updated_at', 'u.display_name as updated_by_name']).execute();
    return { settings: await readPlatformSettings(trx), meta: rows };
  });
}

export async function updatePlatformSettings(actor: AuditActor, patch: Partial<PlatformSettings>) {
  const keys = Object.keys(patch) as PlatformSettingKey[];
  if (!keys.length) throw Errors.invalid('nothing_to_update', 'No settings were changed');
  const result = await withSystem('platform: update settings', async (trx) => {
    const before = await readPlatformSettings(trx);
    for (const k of keys) {
      await trx.insertInto('platform_settings').values({ key: k, value: JSON.stringify(patch[k]), updated_by: actor.userId, updated_at: new Date() })
        .onConflict((oc) => oc.column('key').doUpdateSet({ value: JSON.stringify(patch[k]), updated_by: actor.userId, updated_at: new Date() })).execute();
    }
    const changes = Object.fromEntries(keys.filter((k) => before[k] !== patch[k]).map((k) => [k, { from: before[k], to: patch[k] }]));
    await audit(trx, actor, 'platform.settings.updated', { targetType: 'platform_settings', data: { keys, changes } });
    return readPlatformSettings(trx);
  });
  resetPlatformSettingsCache();
  return result;
}

// ── Maintenance mode: business dashboards only ──────────────────────────────
/**
 * Called for every tenant (dashboard) API request. Storefront, booking and
 * customer routes are not tenant routes and keep working. LUMA support staff
 * acting under a support grant are let through so they can help.
 */
export async function requireDashboardsOpen(access: { role: string }) {
  if (access.role === 'support') return;
  const s = await getPlatformSettings();
  if (s.maintenance_mode) {
    throw new AppError(503, 'maintenance', s.maintenance_message_en || 'LUMA dashboards are under maintenance', { message_ar: s.maintenance_message_ar, message_en: s.maintenance_message_en });
  }
}

/** Maintenance state for dashboard pages (layout renders a maintenance screen). */
export async function dashboardMaintenance(): Promise<{ on: boolean; message_ar: string; message_en: string }> {
  const s = await getPlatformSettings();
  return { on: s.maintenance_mode, message_ar: s.maintenance_message_ar, message_en: s.maintenance_message_en };
}

// ── New-business sign-ups and manual approval ───────────────────────────────
export async function requireSignupsOpen() {
  const s = await getPlatformSettings();
  if (!s.allow_signups) throw Errors.forbidden('New business sign-ups are currently closed', { reason: 'signups_closed' });
  return s;
}

/** Inside createBusiness: records a pending approval when manual approval is on. */
export async function recordApprovalIfRequired(trx: Tx, tenantId: string, settings: PlatformSettings) {
  if (!settings.require_business_approval) return false;
  await trx.insertInto('tenant_approvals').values({ tenant_id: tenantId, status: 'pending' }).execute();
  return true;
}

/** A business pending (or refused) approval cannot publish its storefront. */
export async function requireApprovedForPublish(trx: Tx, tenantId: string) {
  const a = await trx.selectFrom('tenant_approvals').select('status').where('tenant_id', '=', tenantId).executeTakeFirst();
  if (a && a.status !== 'approved') {
    throw Errors.forbidden('Your business is waiting for LUMA approval before going live', { reason: a.status === 'pending' ? 'approval_pending' : 'approval_rejected' });
  }
}

export async function tenantApprovalStatus(trx: Tx, tenantId: string) {
  const a = await trx.selectFrom('tenant_approvals').select(['status', 'reason', 'decided_at']).where('tenant_id', '=', tenantId).executeTakeFirst();
  return a ?? null;
}

export async function listApprovals(q: { status?: 'pending' | 'approved' | 'rejected'; limit: number; cursor?: string }) {
  const cur = decodeCursor<{ t: string; id: string }>(q.cursor);
  return withSystem('platform: business approvals queue', async (trx) => {
    let base = trx.selectFrom('tenant_approvals as a').innerJoin('tenants as t', 't.id', 'a.tenant_id')
      .leftJoin('users as u', 'u.id', 't.created_by');
    base = base.where('a.status', '=', q.status ?? 'pending');
    if (cur) base = base.where((eb) => eb.or([eb('a.created_at', '>', new Date(cur.t)), eb.and([eb('a.created_at', '=', new Date(cur.t)), eb('a.tenant_id', '>', cur.id)])]));
    const rows = await base.select(['a.tenant_id', 'a.status', 'a.reason', 'a.decided_at', 'a.created_at', 't.slug', 't.name', 't.business_type', 't.city', 't.status as tenant_status', 'u.display_name as owner_name'])
      .orderBy('a.created_at').orderBy('a.tenant_id').limit(q.limit + 1).execute();
    const items = rows.slice(0, q.limit);
    const last = items[items.length - 1];
    return { items, next_cursor: rows.length > q.limit && last ? encodeCursor({ t: last.created_at.toISOString(), id: last.tenant_id }) : null };
  });
}

export async function decideApproval(tenantId: string, actor: AuditActor, input: { decision: 'approve' | 'reject'; reason?: string }) {
  return withSystem('platform: decide business approval', async (trx) => {
    const a = await trx.selectFrom('tenant_approvals').selectAll().where('tenant_id', '=', tenantId).forUpdate().executeTakeFirst();
    if (!a) throw Errors.notFound('approval');
    if (input.decision === 'reject' && !input.reason) throw Errors.invalid('reason_required', 'A reason is required to reject');
    const status = input.decision === 'approve' ? 'approved' : 'rejected';
    await trx.updateTable('tenant_approvals').set({ status, reason: input.reason ?? null, decided_by: actor.userId, decided_at: new Date() }).where('tenant_id', '=', tenantId).execute();
    await audit(trx, actor, `platform.tenant.${status}`, { tenantId, targetType: 'tenant', targetId: tenantId, data: { from: a.status, reason: input.reason ?? null } });
    const t = await trx.selectFrom('tenants').select('slug').where('id', '=', tenantId).executeTakeFirst();
    await notifyCapability(trx, tenantId, ['business.manage'], {
      kind: `tenant.approval_${status}`,
      title_ar: status === 'approved' ? 'تمت الموافقة على نشاطكِ في لوما. يمكنكِ نشر متجركِ الآن.' : `لم تتم الموافقة على نشاطكِ: ${input.reason}`,
      title_en: status === 'approved' ? 'Your business was approved on LUMA. You can publish your storefront now.' : `Your business was not approved: ${input.reason}`,
      target_path: t ? `/app/${t.slug}` : undefined,
    });
    return { tenant_id: tenantId, status };
  });
}

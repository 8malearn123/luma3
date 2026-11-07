import { withTenant, type Tx } from '../../db/client';
import { Errors } from '../../http/errors';
import { audit, type AuditActor } from '../../infra/audit';
import type { TenantAccess } from '../../tenancy/access';
import { decryptSecret, encryptSecret } from '../platform/totp';
import {
  instagramProvider, InstagramProviderError, isInstagramMediaUrl, isInstagramPermalink, type InstagramPost,
} from './provider';
import type { PublicInstagram } from '@/shared/builder/storefront';

/**
 * Instagram section data. A business stores its handle (enough for the
 * «تابعينا على إنستقرام» card) and may connect its professional account via
 * the official API; posts are cached on sync so a storefront render never
 * calls Meta. The token is encrypted at rest and never returned.
 */

export const HANDLE_RE = /^[A-Za-z0-9._]{1,30}$/;

/** Accepts "@name", "name" or an instagram.com profile URL; returns the bare handle or null. */
export function normalizeHandle(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.trim();
  try {
    if (/^https?:\/\//i.test(s)) {
      const u = new URL(s);
      if (!/(^|\.)instagram\.com$/.test(u.hostname)) return null;
      s = u.pathname.split('/').filter(Boolean)[0] ?? '';
    }
  } catch { return null; }
  s = s.replace(/^@/, '');
  return HANDLE_RE.test(s) ? s : null;
}

async function row(trx: Tx, tenantId: string) {
  return trx.selectFrom('instagram_connections').selectAll().where('tenant_id', '=', tenantId).executeTakeFirst();
}

/** The handle from the Instagram settings, else from the business's social links. */
async function effectiveHandle(trx: Tx, tenantId: string, stored: string | null | undefined) {
  if (stored) return stored;
  const st = await trx.selectFrom('tenant_settings').select('social_links').where('tenant_id', '=', tenantId).executeTakeFirst();
  const v = (st?.social_links as Record<string, unknown> | undefined)?.instagram;
  return typeof v === 'string' ? normalizeHandle(v) : null;
}

export async function getInstagramSettings(access: TenantAccess) {
  return withTenant(access.tenantId, async (trx) => {
    const r = await row(trx, access.tenantId);
    return {
      handle: r?.handle ?? null,
      effective_handle: await effectiveHandle(trx, access.tenantId, r?.handle),
      status: r?.status ?? 'not_connected',
      provider_configured: instagramProvider().isConfigured(),
      last_synced_at: r?.last_synced_at ?? null,
      last_error: r?.last_error ?? null,
      post_count: Array.isArray(r?.posts) ? (r!.posts as unknown[]).length : 0,
    };
  });
}

export async function setInstagramHandle(access: TenantAccess, actor: AuditActor, raw: string | null) {
  const handle = raw ? normalizeHandle(raw) : null;
  if (raw && !handle) throw Errors.invalid('invalid_handle', 'Enter a valid Instagram username');
  await withTenant(access.tenantId, async (trx) => {
    await trx.insertInto('instagram_connections').values({ tenant_id: access.tenantId, handle, updated_by: actor.userId })
      .onConflict((oc) => oc.column('tenant_id').doUpdateSet({ handle, updated_by: actor.userId })).execute();
    await audit(trx, actor, 'instagram.handle_updated', { tenantId: access.tenantId, targetType: 'instagram', targetId: access.tenantId, data: { handle } });
  });
  return getInstagramSettings(access);
}

function cleanPosts(posts: InstagramPost[]): InstagramPost[] {
  return posts
    .filter((p) => /^[0-9A-Za-z_]{1,64}$/.test(p.id) && isInstagramPermalink(p.permalink) && isInstagramMediaUrl(p.image_url))
    .slice(0, 24)
    .map((p) => ({ ...p, caption: p.caption ? p.caption.slice(0, 300) : null }));
}

/** Connects the professional account with a token from the official login flow. */
export async function connectInstagram(access: TenantAccess, actor: AuditActor, accessToken: string) {
  const prov = instagramProvider();
  if (!prov.isConfigured()) throw Errors.unavailable('instagram_not_configured', 'Instagram connection is not available yet. Your storefront shows a link to your profile instead.');
  let account;
  try {
    account = await prov.fetchAccount(accessToken);
  } catch (e) {
    if (e instanceof InstagramProviderError && e.code === 'invalid_token') throw Errors.invalid('instagram_invalid_token', 'Instagram did not accept this connection. Please try again.');
    throw Errors.unavailable('instagram_unavailable', 'Instagram is not responding right now. Please try again later.');
  }
  await withTenant(access.tenantId, async (trx) => {
    const values = {
      handle: normalizeHandle(account.username), status: 'connected', ig_user_id: account.igUserId, access_token_enc: encryptSecret(accessToken),
      token_expires_at: account.expiresAt, last_error: null, updated_by: actor.userId,
    };
    await trx.insertInto('instagram_connections').values({ tenant_id: access.tenantId, ...values })
      .onConflict((oc) => oc.column('tenant_id').doUpdateSet(values)).execute();
    await audit(trx, actor, 'instagram.connected', { tenantId: access.tenantId, targetType: 'instagram', targetId: access.tenantId, data: { username: account.username } });
  });
  await syncInstagram(access.tenantId);
  return getInstagramSettings(access);
}

export async function disconnectInstagram(access: TenantAccess, actor: AuditActor) {
  await withTenant(access.tenantId, async (trx) => {
    await trx.updateTable('instagram_connections').set({ status: 'not_connected', ig_user_id: null, access_token_enc: null, token_expires_at: null, posts: JSON.stringify([]), last_error: null })
      .where('tenant_id', '=', access.tenantId).execute();
    await audit(trx, actor, 'instagram.disconnected', { tenantId: access.tenantId, targetType: 'instagram', targetId: access.tenantId });
  });
  return getInstagramSettings(access);
}

/** Refreshes the cached posts. Failures keep the previous posts and record the error. */
export async function syncInstagram(tenantId: string): Promise<{ ok: boolean; count: number }> {
  const conn = await withTenant(tenantId, (trx) => row(trx, tenantId));
  if (!conn || conn.status === 'not_connected' || !conn.ig_user_id || !conn.access_token_enc) return { ok: false, count: 0 };
  const prov = instagramProvider();
  try {
    const posts = cleanPosts(await prov.fetchRecentMedia({ igUserId: conn.ig_user_id, accessToken: decryptSecret(conn.access_token_enc), limit: 12 }));
    await withTenant(tenantId, (trx) => trx.updateTable('instagram_connections').set({ posts: JSON.stringify(posts), status: 'connected', last_synced_at: new Date(), last_error: null })
      .where('tenant_id', '=', tenantId).execute());
    return { ok: true, count: posts.length };
  } catch (e) {
    const msg = (e as Error).message.slice(0, 500);
    await withTenant(tenantId, (trx) => trx.updateTable('instagram_connections').set({ status: 'error', last_error: msg }).where('tenant_id', '=', tenantId).execute());
    return { ok: false, count: 0 };
  }
}

/** Storefront read model: handle + profile link always; posts only while connected. */
export async function loadPublicInstagram(trx: Tx, tenantId: string): Promise<PublicInstagram> {
  const r = await row(trx, tenantId);
  const handle = await effectiveHandle(trx, tenantId, r?.handle);
  const connected = r?.status === 'connected';
  const posts = connected && Array.isArray(r?.posts) ? (r!.posts as InstagramPost[]) : [];
  return {
    handle,
    profile_url: handle ? `https://www.instagram.com/${handle}/` : null,
    connected: connected && posts.length > 0,
    posts: posts.map((p) => ({ id: p.id, permalink: p.permalink, caption: p.caption, media_type: p.media_type, timestamp: p.timestamp })),
  };
}

/** Media proxy lookup: only cached posts of a connected account, only Instagram media hosts. */
export async function instagramImageUrl(tenantId: string, postId: string): Promise<string | null> {
  const r = await withTenant(tenantId, (trx) => row(trx, tenantId));
  if (!r || r.status !== 'connected' || !Array.isArray(r.posts)) return null;
  const p = (r.posts as InstagramPost[]).find((x) => x.id === postId);
  return p && isInstagramMediaUrl(p.image_url) ? p.image_url : null;
}

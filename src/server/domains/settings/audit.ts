import { sql } from 'kysely';
import { withTenant } from '../../db/client';
import { decodeCursor, encodeCursor } from '../../http/route';
import type { TenantAccess } from '../../tenancy/access';

/**
 * The business's own audit log (capability audit.view). Rows are already
 * redacted at write time; support-access actions carry support_grant_id and
 * are flagged so the UI can highlight them.
 */
export async function listTenantAudit(access: TenantAccess, q: {
  action?: string; actor_user_id?: string; actor_kind?: string; from?: string; to?: string; support_only?: '0' | '1'; limit: number; cursor?: string;
}) {
  const cur = decodeCursor<{ t: string; id: string }>(q.cursor);
  return withTenant(access.tenantId, async (trx) => {
    let base = trx.selectFrom('audit_logs as a').leftJoin('users as u', 'u.id', 'a.actor_user_id').where('a.tenant_id', '=', access.tenantId);
    if (q.action) base = base.where('a.action', 'like', `${q.action.replace(/[%_]/g, (m) => `\\${m}`)}%`);
    if (q.actor_user_id) base = base.where('a.actor_user_id', '=', q.actor_user_id);
    if (q.actor_kind) base = base.where('a.actor_kind', '=', q.actor_kind);
    if (q.from) base = base.where('a.created_at', '>=', new Date(`${q.from}T00:00:00Z`));
    if (q.to) base = base.where('a.created_at', '<', new Date(new Date(`${q.to}T00:00:00Z`).getTime() + 86_400_000));
    if (q.support_only === '1') base = base.where((eb) => eb.or([eb('a.support_grant_id', 'is not', null), eb('a.actor_kind', '=', 'support'), eb('a.action', 'like', 'platform.support%')]));
    let page = base;
    if (cur) page = page.where(sql<boolean>`(a.created_at, a.id) < (${new Date(cur.t)}, ${cur.id}::uuid)`);
    const rows = await page.select(['a.id', 'a.action', 'a.actor_kind', 'a.actor_user_id', 'a.support_grant_id', 'a.target_type', 'a.target_id', 'a.data', 'a.created_at', 'u.display_name as actor_name'])
      .orderBy('a.created_at', 'desc').orderBy('a.id', 'desc').limit(q.limit + 1).execute();
    const more = rows.length > q.limit;
    const items = rows.slice(0, q.limit).map((r) => ({
      ...r,
      is_support: !!r.support_grant_id || r.actor_kind === 'support' || r.action.startsWith('platform.support'),
      is_platform: r.actor_kind === 'platform' || r.action.startsWith('platform.'),
    }));
    const last = items[items.length - 1];
    let actors: Array<{ id: string; name: string }> = [];
    if (!q.cursor) {
      const a = await trx.selectFrom('audit_logs as a').innerJoin('users as u', 'u.id', 'a.actor_user_id').select(['u.id', 'u.display_name as name'])
        .where('a.tenant_id', '=', access.tenantId).groupBy(['u.id', 'u.display_name']).orderBy('u.display_name').limit(200).execute();
      actors = a;
    }
    return { items, next_cursor: more && last ? encodeCursor({ t: last.created_at.toISOString(), id: last.id }) : null, actors };
  });
}

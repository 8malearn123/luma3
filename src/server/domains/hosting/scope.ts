import { randomBytes, randomInt } from 'node:crypto';
import { sql } from 'kysely';
import { withSystem, type Tx } from '../../db/client';
import { Errors } from '../../http/errors';
import type { TenantAccess } from '../../tenancy/access';
import type { WsActor } from '@/shared/schemas/hosting';

/**
 * Cross-tenant access for workspace hosting.
 *
 * A space booking touches two tenants (host salon + guest expert). Every write
 * that crosses the boundary goes through this module's two entry points, each
 * with a stated reason (recorded by withSystem's contract and in audit logs):
 *  - hostingTx(reason, fn)  a new system-scoped transaction (API operations);
 *  - asSystem(trx, reason, fn)  escalates INSIDE an existing tenant transaction
 *    (payment webhooks run in the host tenant; the guest-side journal and
 *    allocations must commit atomically with the capture).
 * Authorisation is always checked first against the caller's resolved
 * TenantAccess: a booking is only visible to its host or its guest (404
 * otherwise, never "forbidden", so ids cannot be probed).
 */
export function hostingTx<T>(reason: string, fn: (trx: Tx) => Promise<T>) {
  return withSystem(`hosting: ${reason}`, fn);
}

export async function asSystem<T>(trx: Tx, reason: string, fn: () => Promise<T>): Promise<T> {
  if (!reason) throw new Error('asSystem requires a reason');
  const prev = (await sql<{ v: string | null }>`select current_setting('app.scope', true) as v`.execute(trx)).rows[0]?.v ?? '';
  if (prev === 'system') return fn();
  await sql`select set_config('app.scope', 'system', true)`.execute(trx);
  try {
    return await fn();
  } finally {
    // If fn failed with a database error the transaction is aborted and rolls back anyway.
    try { await sql`select set_config('app.scope', ${prev}, true)`.execute(trx); } catch { /* aborted transaction */ }
  }
}

export type WsRow = Awaited<ReturnType<typeof lockBooking>>;

export async function lockBooking(trx: Tx, id: string) {
  const w = await trx.selectFrom('workspace_bookings').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
  if (!w) throw Errors.notFound('workspace_booking');
  return w;
}

/** The booking as seen by this caller: host or guest; anyone else gets 404. */
export async function lockFor(trx: Tx, access: TenantAccess, id: string, side: 'host' | 'guest' | 'either') {
  const w = await trx.selectFrom('workspace_bookings').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
  if (!w) throw Errors.notFound('workspace_booking');
  const isHost = w.host_tenant_id === access.tenantId, isGuest = w.guest_tenant_id === access.tenantId;
  if ((side === 'host' && !isHost) || (side === 'guest' && !isGuest) || (side === 'either' && !isHost && !isGuest)) throw Errors.notFound('workspace_booking');
  return { w, as: (isHost ? 'host' : 'guest') as 'host' | 'guest' };
}

export async function nextWorkspaceNumber(trx: Tx, hostTenantId: string) {
  const r = await sql<{ value: number }>`
    insert into tenant_counters (tenant_id, kind, value) values (${hostTenantId}, 'workspace_booking', 1)
    on conflict (tenant_id, kind) do update set value = tenant_counters.value + 1 returning value`.execute(trx);
  return `WSB-${String(r.rows[0]!.value).padStart(6, '0')}`;
}

export const newCheckInCode = () => String(randomInt(0, 1_000_000)).padStart(6, '0');
export const newQrToken = () => `wsq_${randomBytes(24).toString('base64url')}`;

export async function recordEvent(trx: Tx, w: { id: string; host_tenant_id: string; guest_tenant_id: string }, e: { from: string | null; to: string | null; actor: WsActor; userId?: string | null; reason?: string | null; kind?: string; data?: Record<string, unknown> }) {
  await trx.insertInto('workspace_booking_events').values({
    workspace_booking_id: w.id, host_tenant_id: w.host_tenant_id, guest_tenant_id: w.guest_tenant_id, from_status: e.from, to_status: e.to,
    kind: e.kind ?? 'transition', actor_kind: e.actor, actor_user_id: e.userId ?? null, reason: e.reason ?? null, data: JSON.stringify(e.data ?? {}),
  }).execute();
}

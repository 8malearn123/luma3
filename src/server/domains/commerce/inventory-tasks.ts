import { sql } from 'kysely';
import { withSystem, withTenant, type Tx } from '../../db/client';
import { Errors } from '../../http/errors';
import { audit, type AuditActor } from '../../infra/audit';
import { notifyCapability } from '../../infra/notify';
import type { TenantAccess } from '../../tenancy/access';
import { resolveShortage } from './consumption';
import { getSettings } from './locations';

/**
 * Inventory tasks: shortage (a service needed more than the location held),
 * expiry (a tracked batch near or past its expiry date) and reorder (a
 * location fell to its reorder level). One open task per subject; reorder
 * tasks close themselves when restocked.
 */
export async function listTasks(access: TenantAccess, q: { status: 'open' | 'resolved' | 'dismissed' | 'all'; kind?: string }) {
  return withTenant(access.tenantId, async (trx) => {
    let s = trx.selectFrom('inventory_tasks as t').leftJoin('inventory_items as i', 'i.id', 't.inventory_item_id').leftJoin('stock_locations as l', 'l.id', 't.location_id')
      .select(['t.id', 't.kind', 't.status', 't.inventory_item_id', 'i.name as item_name', 'i.unit', 't.location_id', 'l.name as location_name', 't.ref_type', 't.ref_id',
        't.payload', 't.resolution', 't.resolved_at', 't.created_at']);
    if (q.status !== 'all') s = s.where('t.status', '=', q.status);
    if (q.kind) s = s.where('t.kind', '=', q.kind);
    return s.orderBy('t.created_at', 'desc').limit(300).execute();
  });
}

export async function resolveTask(access: TenantAccess, actor: AuditActor, id: string, action: 'post_remaining' | 'write_off' | 'dismiss' | 'resolve', resolution?: string) {
  return withTenant(access.tenantId, async (trx) => {
    const t = await trx.selectFrom('inventory_tasks').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
    if (!t) throw Errors.notFound('inventory_task');
    if (t.status !== 'open') throw Errors.conflict('task_closed', 'This task is already closed');
    let remaining = 0;
    if (t.kind === 'shortage' && (action === 'post_remaining' || action === 'write_off')) {
      if (action === 'write_off' && !resolution) throw Errors.invalid('reason_required', 'Explain why the missing quantity is written off');
      remaining = (await resolveShortage(trx, access, actor, t.ref_id!, action, resolution)).remaining;
    } else if (action === 'post_remaining' || action === 'write_off') {
      throw Errors.invalid('invalid_action');
    } else {
      await trx.updateTable('inventory_tasks').set({ status: action === 'dismiss' ? 'dismissed' : 'resolved', resolution: resolution ?? null, resolved_by: actor.userId, resolved_at: new Date() })
        .where('id', '=', id).execute();
    }
    await audit(trx, actor, 'inventory.task_resolved', { tenantId: access.tenantId, targetType: 'inventory_task', targetId: id, data: { action, resolution: resolution ?? null } });
    const fresh = await trx.selectFrom('inventory_tasks').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    return { ...fresh, remaining };
  });
}

/** Opens one expiry task per batch × location that holds stock and expires within the business's warning window. */
export async function scanExpiry(trx: Tx, tenantId: string, today = new Date()) {
  const { expiry_warning_days: days } = await getSettings(trx, tenantId);
  const limit = new Date(today.getTime() + days * 86_400_000).toISOString().slice(0, 10);
  const rows = await trx.selectFrom('stock_batch_balances as bb').innerJoin('stock_batches as b', 'b.id', 'bb.batch_id').innerJoin('inventory_items as i', 'i.id', 'b.inventory_item_id')
    .select(['bb.batch_id', 'bb.location_id', 'bb.quantity', 'b.batch_no', 'b.expiry_date', 'b.inventory_item_id', 'i.name'])
    .where('bb.tenant_id', '=', tenantId).where('bb.quantity', '>', 0).where('b.expiry_date', 'is not', null).where('b.expiry_date', '<=', limit).execute();
  let opened = 0;
  for (const r of rows) {
    const res = await sql`insert into inventory_tasks (tenant_id, kind, inventory_item_id, location_id, ref_type, ref_id, dedupe_key, payload)
      values (${tenantId}, 'expiry', ${r.inventory_item_id}, ${r.location_id}, 'stock_batch', ${r.batch_id}, ${`expiry:${r.batch_id}:${r.location_id}`},
        ${JSON.stringify({ name: r.name, batch_no: r.batch_no, expiry_date: r.expiry_date, quantity: Number(r.quantity) })}::jsonb)
      on conflict (tenant_id, dedupe_key) where status = 'open' do nothing`.execute(trx);
    opened += Number(res.numAffectedRows ?? 0);
  }
  if (opened) {
    await notifyCapability(trx, tenantId, ['inventory.manage'], {
      kind: 'inventory.expiry', title_ar: `دفعات قريبة من انتهاء الصلاحية: ${opened}`, title_en: `Batches near expiry: ${opened}`,
      body_ar: 'راجعي مهام المخزون وقرري الصرف أو الإتلاف.', body_en: 'Review the inventory tasks and decide to use or discard.',
      dedupe_key: `expiry_scan:${tenantId}:${today.toISOString().slice(0, 10)}`,
    });
  }
  return { opened };
}

/** Daily expiry scan across businesses that track batches. */
export async function runExpiryScan() {
  const tenants = await withSystem('expiry scan: tenants tracking batches', (trx) => trx.selectFrom('stock_batches').select('tenant_id').distinct().execute());
  let opened = 0;
  for (const t of tenants) opened += (await withTenant(t.tenant_id, (trx) => scanExpiry(trx, t.tenant_id))).opened;
  return { opened };
}

import { audit, schedule, withSystem, type AuditActor, type Tx } from './db';

/**
 * Which host a business lives in. LUMA tenants are the default; a business
 * with a loom.businesses row of host 'external' has no LUMA tenant at all —
 * its id is only an RLS scope id for schema loom (docs/LOOM_CORE.md §20).
 * Host-owned tables (audit_logs, job_runs) reference tenants, so for an
 * external business Loom audits into loom.audit_events and schedules jobs
 * without a tenant id (the payload carries business_id).
 */
export type BusinessHost = 'luma' | 'external';
const known = new Map<string, BusinessHost>();

export async function businessHost(trx: Tx, businessId: string): Promise<BusinessHost> {
  const k = known.get(businessId);
  if (k) return k;
  const row = await trx.selectFrom('loom.businesses').select('host').where('id', '=', businessId).executeTakeFirst();
  const host: BusinessHost = row?.host === 'external' ? 'external' : 'luma';
  // A business never changes host; only remember positives of the row lookup.
  if (row) known.set(businessId, host);
  return host;
}

export async function loomAudit(trx: Tx, actor: AuditActor, action: string, businessId: string, opts: { targetType?: string; targetId?: string | null; data?: Record<string, unknown> } = {}) {
  if ((await businessHost(trx, businessId)) === 'luma') {
    await audit(trx, actor, action, { tenantId: businessId, targetType: opts.targetType, targetId: opts.targetId ?? null, data: opts.data });
    return;
  }
  await trx.insertInto('loom.audit_events').values({
    business_id: businessId, actor_user_id: actor.userId, actor_kind: actor.kind, action, target_type: opts.targetType ?? null,
    target_id: opts.targetId ?? null, data: JSON.stringify(redactSecrets(opts.data ?? {})),
  }).execute();
}

const SECRET_KEY = /secret|token|password|api[_-]?key|authorization/i;
export function redactSecrets(v: unknown, depth = 0): unknown {
  if (depth > 4) return '[depth]';
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => redactSecrets(x, depth + 1));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET_KEY.test(k) ? '[redacted]' : redactSecrets(x, depth + 1)]));
  return v;
}

/**
 * Schedules a Loom job for a business. LUMA tenants: in the caller's
 * transaction with the tenant id. External businesses: job_runs.tenant_id
 * references tenants, so the job is written in system scope with the
 * business id in the payload (handlers re-verify it, see jobs.ts). Handlers
 * must tolerate running before the caller's transaction commits (they retry).
 */
export async function scheduleForBusiness(trx: Tx, businessId: string, kind: string, payload: Record<string, unknown>, opts: { dedupeKey?: string; maxAttempts?: number; runAt?: Date } = {}) {
  const body = { ...payload, business_id: businessId };
  if ((await businessHost(trx, businessId)) === 'luma') {
    await schedule(trx, kind, body, { tenantId: businessId, ...opts });
    return;
  }
  await withSystem('loom: schedule job for an external business', (sys) => schedule(sys, kind, body, { tenantId: null, ...opts }));
}

/** Resolves the business a job runs for: the tenant id (LUMA) or a verified external business id from the payload. */
export async function jobBusiness(tenantId: string | null, payload: Record<string, unknown>): Promise<string> {
  if (tenantId) return tenantId;
  const id = String(payload.business_id ?? '');
  const row = await withSystem('loom: verify external business of a job', (trx) => trx.selectFrom('loom.businesses').select(['id', 'host', 'status']).where('id', '=', id).executeTakeFirst());
  if (!row || row.host !== 'external' || row.status !== 'active') throw new Error('loom job without a valid business');
  return row.id;
}

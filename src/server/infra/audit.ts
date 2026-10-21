import type { Tx } from '../db/client';

export type AuditActor = {
  userId: string | null;
  kind: 'user' | 'platform' | 'support' | 'system' | 'customer' | 'anonymous';
  supportGrantId?: string | null;
  requestId?: string | null;
  ip?: string | null;
};

const SENSITIVE_KEYS = /pass(word)?|secret|token|otp|code_hash|card|cvv|pan|api[_-]?key|authorization/i;

/** Drops secret-looking keys and truncates long strings before persisting. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[depth]';
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = SENSITIVE_KEYS.test(k) ? '[redacted]' : redact(v, depth + 1);
    return out;
  }
  if (typeof value === 'string' && value.length > 500) return `${value.slice(0, 500)}…`;
  return value;
}

/** Writes an audit record inside the caller's transaction (append-only table). */
export async function audit(
  trx: Tx,
  actor: AuditActor,
  action: string,
  opts: { tenantId?: string | null; targetType?: string; targetId?: string | null; data?: Record<string, unknown> } = {},
) {
  await trx
    .insertInto('audit_logs')
    .values({
      tenant_id: opts.tenantId ?? null,
      actor_user_id: actor.userId,
      actor_kind: actor.kind,
      support_grant_id: actor.supportGrantId ?? null,
      action,
      target_type: opts.targetType ?? null,
      target_id: opts.targetId ?? null,
      request_id: actor.requestId ?? null,
      ip: actor.ip ?? null,
      data: JSON.stringify(redact(opts.data ?? {})),
    })
    .execute();
}

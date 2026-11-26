import type { Tx } from '../db/client';

/**
 * Minimal in-process domain events, emitted inside the domain transaction.
 * Domains call `emitDomainEvent` at a few change points that other modules
 * need to observe without importing the domain (today: the Loom host adapter,
 * src/server/loom-host/changes.ts, which turns them into Loom change signals).
 * Listeners must be cheap and must not throw for unrelated tenants.
 */
export type DomainEvent =
  | { type: 'stock.moved'; item_id: string; available: number; threshold: number | null }
  | { type: 'leave.approved'; leave_id: string; staff_id: string; from: Date; to: Date }
  | { type: 'service.economics_changed'; service_id: string; price_before: number; price_after: number; cost_before: number | null; cost_after: number | null };

type Listener = (trx: Tx, tenantId: string, e: DomainEvent) => Promise<void>;
const listeners: Listener[] = [];

export function onDomainEvent(l: Listener) { if (!listeners.includes(l)) listeners.push(l); }

export async function emitDomainEvent(trx: Tx, tenantId: string, e: DomainEvent) {
  for (const l of listeners) await l(trx, tenantId, e);
}

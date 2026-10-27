import { sql, type Tx } from '../db/client';

/** Per-tenant gap-free counter for human-readable numbers (BKG-000123, ORD-…). */
export async function nextNumber(trx: Tx, tenantId: string, kind: 'booking' | 'order' | 'invoice' | 'receipt' | 'credit_note' | 'stock_count'): Promise<number> {
  const res = await sql<{ value: number }>`
    insert into tenant_counters (tenant_id, kind, value) values (${tenantId}, ${kind}, 1)
    on conflict (tenant_id, kind) do update set value = tenant_counters.value + 1
    returning value`.execute(trx);
  return res.rows[0]!.value;
}

const PREFIX = { booking: 'BKG', order: 'ORD', invoice: 'INV', receipt: 'RCT', credit_note: 'CRN', stock_count: 'CNT' } as const;

export async function nextReadableNumber(trx: Tx, tenantId: string, kind: keyof typeof PREFIX) {
  const n = await nextNumber(trx, tenantId, kind);
  return `${PREFIX[kind]}-${String(n).padStart(6, '0')}`;
}

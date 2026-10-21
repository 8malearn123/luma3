import type { Tx } from '../../db/client';

/**
 * Returns the business-local customer record for a central LUMA user, creating
 * it on first interaction (booking, order, waitlist). The business sees only
 * this relationship row, never the user's activity at other businesses.
 * Must be called inside withTenant(tenantId).
 */
export async function ensureTenantCustomerForUser(
  trx: Tx,
  tenantId: string,
  user: { userId: string; displayName: string; phone: string | null; email: string | null },
  source: 'storefront' | 'dashboard' | 'walk_in' = 'storefront',
): Promise<string> {
  const existing = await trx.selectFrom('tenant_customers').select('id').where('tenant_id', '=', tenantId).where('user_id', '=', user.userId).executeTakeFirst();
  if (existing) return existing.id;
  const row = await trx.insertInto('tenant_customers').values({
    tenant_id: tenantId, user_id: user.userId, display_name: user.displayName, phone: user.phone, email: user.email, source,
  }).onConflict((oc) => oc.columns(['tenant_id', 'user_id']).where('user_id', 'is not', null).doNothing())
    .returning('id').executeTakeFirst();
  if (row) return row.id;
  // Lost a race with a concurrent first booking; read the winner.
  const again = await trx.selectFrom('tenant_customers').select('id').where('tenant_id', '=', tenantId).where('user_id', '=', user.userId).executeTakeFirstOrThrow();
  return again.id;
}

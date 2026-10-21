import { sql } from 'kysely';
import { db, withTenant } from '../../db/client';
import type { SessionUser } from '../../auth/service';
import { Errors } from '../../http/errors';
import { hasCapability, resolveTenantAccess } from '../../tenancy/access';

/**
 * Who may drive the sandbox "provider" pages: the payer of the payment, or a
 * member of the owning business who can collect payments / approve refunds.
 * Anyone else gets 404 (no hint that the id exists).
 */
export async function requireSandboxActor(user: SessionUser, ref: { providerPaymentId: string } | { providerRefundId: string }) {
  let tenantId: string | undefined;
  let paymentId: string | undefined;
  if ('providerPaymentId' in ref) {
    const r = await sql<{ id: string; tenant_id: string }>`select * from app.payment_by_provider_ref('sandbox', ${ref.providerPaymentId})`.execute(db());
    tenantId = r.rows[0]?.tenant_id; paymentId = r.rows[0]?.id;
  } else {
    const r = await sql<{ id: string; tenant_id: string }>`select * from app.refund_by_provider_ref(${ref.providerRefundId})`.execute(db());
    tenantId = r.rows[0]?.tenant_id;
    if (r.rows[0]) paymentId = (await withTenant(r.rows[0].tenant_id, (trx) => trx.selectFrom('refunds').select('payment_id').where('id', '=', r.rows[0]!.id).executeTakeFirst()))?.payment_id;
  }
  if (!tenantId || !paymentId) throw Errors.notFound();
  const pay = await withTenant(tenantId, (trx) => trx.selectFrom('payments').select('payer_user_id').where('id', '=', paymentId!).executeTakeFirst());
  if (pay?.payer_user_id === user.userId) return;
  const m = await sql<{ slug: string }>`select tenant_slug as slug from app.memberships_for_user(${user.userId}) where tenant_id = ${tenantId}`.execute(db());
  const slug = m.rows[0]?.slug;
  if (slug && hasCapability(await resolveTenantAccess(user, slug), ['payments.collect', 'refunds.approve'])) return;
  throw Errors.notFound();
}

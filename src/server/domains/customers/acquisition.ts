import { sql } from 'kysely';
import { withTenant, type Tx } from '../../db/client';
import { Errors } from '../../http/errors';
import { audit, type AuditActor } from '../../infra/audit';
import type { TenantAccess } from '../../tenancy/access';
import { classifyAttribution, type AcquisitionSource, type HeardFrom } from '@/shared/acquisition';

/**
 * Acquisition source per business relationship («كيف عرفتِ عنا؟»), first touch:
 *
 *  1. Inferred from the storefront analytics session that led to the booking or
 *     purchase: the first event carrying a referrer or UTM (see
 *     classifyAttribution). A session with no attribution at all is 'direct'.
 *  2. If nothing could be inferred (no session) or the session was 'direct',
 *     her optional answer at registration is used once.
 *  3. Otherwise the storefront asks her (optional); her answer replaces only an
 *     unknown or 'direct' value — an inferred specific source is never overwritten.
 *
 * Once a specific source is stored it never changes (first touch).
 */
type Row = { acquisition_source: string | null; acquisition_method: string | null };

export const needsQuestion = (r: Row) => r.acquisition_source == null || r.acquisition_source === 'direct';

async function firstTouch(trx: Tx, sessionId: string): Promise<{ source: AcquisitionSource; detail: Record<string, unknown> } | null> {
  const events = await trx.selectFrom('analytics_events').select(['referrer_host', 'utm', 'occurred_at', 'path'])
    .where('session_id', '=', sessionId).where('type', 'not in', ['booking_confirmed', 'order_paid'])
    .orderBy('occurred_at').limit(200).execute();
  // A session that arrived from سوق لوما (recorded by domains/marketplace) is a marketplace customer.
  const mv = await trx.selectFrom('marketplace_visits').select('created_at').where('session_id', '=', sessionId).executeTakeFirst();
  if (mv) return { source: 'marketplace', detail: { via: 'luma_market', at: mv.created_at, landing_path: events[0]?.path ?? null } };
  if (!events.length) return null;
  const touched = events.find((e) => e.referrer_host || e.utm) ?? events[0]!;
  const utm = (touched.utm ?? null) as { source?: string; medium?: string; campaign?: string } | null;
  const source = classifyAttribution({ referrerHost: touched.referrer_host, utm });
  return { source, detail: { referrer_host: touched.referrer_host, utm, landing_path: touched.path, at: touched.occurred_at } };
}

/** Infers and stores the source for one relationship (inside withTenant). Returns whether the question is still needed. */
export async function inferAcquisition(trx: Tx, tenantId: string, tenantCustomerId: string, sessionId: string | null) {
  const tc = await trx.selectFrom('tenant_customers').select(['id', 'user_id', 'acquisition_source', 'acquisition_method'])
    .where('tenant_id', '=', tenantId).where('id', '=', tenantCustomerId).forUpdate().executeTakeFirst();
  if (!tc) return { source: null, needs_question: false };
  if (!needsQuestion(tc)) return { source: tc.acquisition_source, needs_question: false };
  // First touch: once 'direct' was recorded, a later session never re-attributes her.
  const inferred = tc.acquisition_source == null && sessionId ? await firstTouch(trx, sessionId) : null;
  let next: { source: string; method: 'inferred' | 'asked'; detail: Record<string, unknown> } | null = null;
  if (inferred && inferred.source !== 'direct') next = { source: inferred.source, method: 'inferred', detail: { ...inferred.detail, session_id: sessionId } };
  else if (tc.user_id) {
    // Her registration answer is used once, for the first relationship we cannot infer.
    const p = await trx.updateTable('customer_profiles').set({ heard_from_used_at: new Date() })
      .where('user_id', '=', tc.user_id).where('heard_from', 'is not', null).where('heard_from_used_at', 'is', null)
      .returning('heard_from').executeTakeFirst();
    if (p?.heard_from) next = { source: p.heard_from, method: 'asked', detail: { asked_at: 'registration' } };
  }
  if (!next && inferred && tc.acquisition_source == null) next = { source: 'direct', method: 'inferred', detail: { ...inferred.detail, session_id: sessionId } };
  if (!next) return { source: tc.acquisition_source, needs_question: true };
  await trx.updateTable('tenant_customers').set({
    acquisition_source: next.source, acquisition_method: next.method, acquisition_detail: JSON.stringify(next.detail), acquisition_at: new Date(),
  }).where('id', '=', tc.id).execute();
  return { source: next.source, needs_question: next.source === 'direct' };
}

/** Called by storefront routes after a hold or purchase created/used the relationship. Never fails the request. */
export async function recordAcquisition(tenantId: string, ref: { bookingId?: string; tenantCustomerId?: string }, sessionId: string | null) {
  try {
    return await withTenant(tenantId, async (trx) => {
      const tcId = ref.tenantCustomerId ?? (await trx.selectFrom('bookings').select('tenant_customer_id').where('id', '=', ref.bookingId!).executeTakeFirst())?.tenant_customer_id;
      if (!tcId) return null;
      return inferAcquisition(trx, tenantId, tcId, sessionId);
    });
  } catch (e) {
    console.error('[acquisition]', (e as Error).message);
    return null;
  }
}

/** Whether the storefront should ask her (only when the source is unknown or merely 'direct'). */
export async function acquisitionStatus(tenantId: string, userId: string) {
  return withTenant(tenantId, async (trx) => {
    const tc = await trx.selectFrom('tenant_customers').select(['acquisition_source', 'acquisition_method']).where('tenant_id', '=', tenantId).where('user_id', '=', userId).executeTakeFirst();
    if (!tc) return { needs_question: false, source: null };
    return { needs_question: needsQuestion(tc), source: tc.acquisition_method === 'asked' ? tc.acquisition_source : null };
  });
}

/** Her own answer. Replaces only an unknown or 'direct' value. */
export async function answerAcquisition(tenantId: string, userId: string, answer: HeardFrom, actor: AuditActor) {
  return withTenant(tenantId, async (trx) => {
    const tc = await trx.selectFrom('tenant_customers').select(['id', 'acquisition_source', 'acquisition_method', 'acquisition_detail'])
      .where('tenant_id', '=', tenantId).where('user_id', '=', userId).forUpdate().executeTakeFirst();
    if (!tc) throw Errors.notFound('customer');
    if (!needsQuestion(tc)) return { source: tc.acquisition_source, changed: false };
    await trx.updateTable('tenant_customers').set({
      acquisition_source: answer, acquisition_method: 'asked', acquisition_at: new Date(),
      acquisition_detail: JSON.stringify({ asked_at: 'storefront', previous: tc.acquisition_source }),
    }).where('id', '=', tc.id).execute();
    await audit(trx, actor, 'customer.acquisition_answered', { tenantId, targetType: 'tenant_customer', targetId: tc.id, data: { source: answer } });
    return { source: answer, changed: true };
  });
}

/** Analytics: new customers by acquisition source in a period (by relationship creation). */
export async function acquisitionReport(access: TenantAccess, period: { from: Date; to: Date }) {
  return withTenant(access.tenantId, async (trx) => {
    const rows = await trx.selectFrom('tenant_customers')
      .select([sql<string>`coalesce(acquisition_source, 'unknown')`.as('source'), sql<number>`count(*)::int`.as('customers'),
        sql<number>`count(*) filter (where acquisition_method = 'asked')::int`.as('asked'),
        sql<number>`count(*) filter (where exists (select 1 from bookings b where b.tenant_customer_id = tenant_customers.id and b.status = 'completed'))::int`.as('visited')])
      .where('tenant_id', '=', access.tenantId).where('created_at', '>=', period.from).where('created_at', '<', period.to)
      .groupBy(sql`coalesce(acquisition_source, 'unknown')`).orderBy(sql`count(*)`, 'desc').execute();
    const total = rows.reduce((a, r) => a + r.customers, 0);
    return { from: period.from.toISOString(), to: period.to.toISOString(), total, sources: rows.map((r) => ({ ...r, share_bp: total ? Math.round((r.customers * 10000) / total) : 0 })) };
  });
}

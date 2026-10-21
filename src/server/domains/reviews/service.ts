import { sql } from 'kysely';
import type { z } from 'zod';
import { withTenant, type Tx } from '../../db/client';
import { Errors } from '../../http/errors';
import { audit, type AuditActor } from '../../infra/audit';
import type { TenantAccess } from '../../tenancy/access';
import type { reviewListQuery, reviewModeration, reviewReply } from '@/shared/schemas/customers';
import { offsetOf, page } from '../policy/paging';

/**
 * Visit-linked reviews: one per completed booking by the customer who visited
 * (DB trigger + unique index). Businesses can reply and moderate (hide/flag
 * with a reason, audited) but never delete a review.
 */

export async function listReviews(access: TenantAccess, q: z.infer<typeof reviewListQuery>) {
  return withTenant(access.tenantId, async (trx) => {
    const offset = offsetOf(q.cursor);
    let query = trx.selectFrom('reviews as r')
      .innerJoin('tenant_customers as c', (j) => j.onRef('c.id', '=', 'r.tenant_customer_id').onRef('c.tenant_id', '=', 'r.tenant_id'))
      .innerJoin('bookings as b', (j) => j.onRef('b.id', '=', 'r.booking_id').onRef('b.tenant_id', '=', 'r.tenant_id'))
      .leftJoin('staff_profiles as s', (j) => j.onRef('s.id', '=', 'r.staff_id').onRef('s.tenant_id', '=', 'r.tenant_id'))
      .select(['r.id', 'r.rating', 'r.comment', 'r.status', 'r.business_reply', 'r.replied_at', 'r.moderation_reason', 'r.moderated_at', 'r.created_at',
        'r.tenant_customer_id', 'c.display_name as customer_name', 'b.number as booking_number', 'b.starts_at as visit_at', 's.display_name as staff_name'])
      .where('r.tenant_id', '=', access.tenantId);
    if (q.status !== 'all') query = query.where('r.status', '=', q.status);
    if (q.rating) query = query.where('r.rating', '=', q.rating);
    const rows = await query.orderBy('r.created_at', 'desc').orderBy('r.id').limit(q.limit + 1).offset(offset).execute();
    const stats = await trx.selectFrom('reviews').select([sql<number>`count(*)::int`.as('n'), sql<number | null>`round(avg(rating)::numeric, 2)`.as('avg')])
      .where('tenant_id', '=', access.tenantId).where('status', '=', 'published').executeTakeFirstOrThrow();
    return { ...page(rows, q.limit, offset), stats: { published: stats.n, average: stats.avg === null ? null : Number(stats.avg) } };
  });
}

export async function replyToReview(access: TenantAccess, actor: AuditActor, id: string, input: z.infer<typeof reviewReply>) {
  return withTenant(access.tenantId, async (trx) => {
    const row = await trx.updateTable('reviews').set({ business_reply: input.reply, replied_by: input.reply ? actor.userId : null, replied_at: input.reply ? new Date() : null })
      .where('tenant_id', '=', access.tenantId).where('id', '=', id).returning(['id', 'business_reply', 'replied_at']).executeTakeFirst();
    if (!row) throw Errors.notFound('review');
    await audit(trx, actor, 'review.replied', { tenantId: access.tenantId, targetType: 'review', targetId: id, data: { removed: !input.reply } });
    return row;
  });
}

export async function moderateReview(access: TenantAccess, actor: AuditActor, id: string, input: z.infer<typeof reviewModeration>) {
  return withTenant(access.tenantId, async (trx) => {
    const cur = await trx.selectFrom('reviews').select(['id', 'status']).where('tenant_id', '=', access.tenantId).where('id', '=', id).forUpdate().executeTakeFirst();
    if (!cur) throw Errors.notFound('review');
    const row = await trx.updateTable('reviews').set({ status: input.status, moderation_reason: input.reason, moderated_by: actor.userId, moderated_at: new Date() })
      .where('id', '=', id).returning(['id', 'status', 'moderation_reason', 'moderated_at']).executeTakeFirstOrThrow();
    await audit(trx, actor, 'review.moderated', { tenantId: access.tenantId, targetType: 'review', targetId: id, data: { from: cur.status, to: input.status, reason: input.reason } });
    return row;
  });
}

/**
 * Published reviews for the storefront (inside the storefront's withTenant).
 * The author label is the first word of the name only; no contact data.
 */
export async function listPublishedReviews(trx: Tx, tenantId: string, opts: { limit?: number; staffId?: string } = {}) {
  let q = trx.selectFrom('reviews as r')
    .innerJoin('tenant_customers as c', (j) => j.onRef('c.id', '=', 'r.tenant_customer_id').onRef('c.tenant_id', '=', 'r.tenant_id'))
    .select(['r.id', 'r.rating', 'r.comment', 'r.business_reply', 'r.created_at', 'r.staff_id', sql<string>`split_part(c.display_name, ' ', 1)`.as('author_label')])
    .where('r.tenant_id', '=', tenantId).where('r.status', '=', 'published');
  if (opts.staffId) q = q.where('r.staff_id', '=', opts.staffId);
  return q.orderBy('r.created_at', 'desc').limit(Math.min(opts.limit ?? 20, 100)).execute();
}

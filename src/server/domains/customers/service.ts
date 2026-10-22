import { sql } from 'kysely';
import type { z } from 'zod';
import { withTenant } from '../../db/client';
import { Errors } from '../../http/errors';
import { audit, type AuditActor } from '../../infra/audit';
import { hasCapability, type TenantAccess } from '../../tenancy/access';
import { normalizePhone } from '@/shared/phone';
import type { consentInput, customerCreate, customerListQuery, customerPatch } from '@/shared/schemas/customers';
import { decisionEffect } from '../policy/decisions';
import { likeTerm, offsetOf, page } from '../policy/paging';
import { effectiveConsents, recordConsent } from './consents';

/**
 * Business-side CRM. Everything runs in withTenant(access.tenantId): a business
 * sees only its own relationship rows and its own bookings/orders with a
 * customer — never her activity elsewhere. There is deliberately no endpoint
 * that looks up LUMA accounts by phone or email; walk-ins stay local records.
 */

const LIST_COLS = ['id', 'display_name', 'phone', 'email', 'tags', 'source', 'status', 'first_visit_at', 'last_visit_at', 'created_at', 'updated_at', 'version'] as const;

function normPhone(v: string | null | undefined) {
  if (v == null || v === '') return null;
  const p = normalizePhone(v);
  if (!p) throw Errors.invalid('invalid_phone');
  return p;
}

export async function listCustomers(access: TenantAccess, q: z.infer<typeof customerListQuery>) {
  return withTenant(access.tenantId, async (trx) => {
    const offset = offsetOf(q.cursor);
    let query = trx.selectFrom('tenant_customers').select([...LIST_COLS, sql<boolean>`user_id is not null`.as('has_account')]).where('tenant_id', '=', access.tenantId);
    if (q.status !== 'all') query = query.where('status', '=', q.status);
    if (q.source) query = query.where('source', '=', q.source);
    if (q.tag) query = query.where(sql<boolean>`${q.tag} = any(tags)`);
    if (q.q) {
      const term = likeTerm(q.q);
      const phone = normalizePhone(q.q);
      query = query.where((eb) => eb.or([
        eb('display_name', 'ilike', term), eb('email', 'ilike', term), eb('phone', 'ilike', term),
        ...(phone ? [eb('phone', '=', phone)] : []),
      ]));
    }
    query = q.sort === 'name' ? query.orderBy(sql`lower(display_name)`, 'asc')
      : q.sort === 'last_visit' ? query.orderBy(sql`last_visit_at desc nulls last`)
        : q.sort === 'created' ? query.orderBy('created_at', 'desc')
          : query.orderBy('updated_at', 'desc');
    const rows = await query.orderBy('id').limit(q.limit + 1).offset(offset).execute();
    return page(rows, q.limit, offset);
  });
}

export async function getCustomer(access: TenantAccess, id: string) {
  const canNotes = hasCapability(access, 'customers.view_notes');
  const canReview = hasCapability(access, 'incidents.review');
  const canFinancial = hasCapability(access, ['bookings.view_financial', 'orders.view']);
  return withTenant(access.tenantId, async (trx) => {
    const c = await trx.selectFrom('tenant_customers').selectAll().where('tenant_id', '=', access.tenantId).where('id', '=', id).executeTakeFirst();
    if (!c) throw Errors.notFound('customer');
    const [bookings, orders, decisions, reviews, consents] = await Promise.all([
      trx.selectFrom('bookings').select(['id', 'number', 'status', 'payment_status', 'starts_at', 'ends_at', 'timezone', 'total_minor', 'currency', 'source'])
        .where('tenant_id', '=', access.tenantId).where('tenant_customer_id', '=', id).orderBy('starts_at', 'desc').limit(50).execute(),
      trx.selectFrom('orders').select(['id', 'number', 'status', 'total_minor', 'currency', 'created_at'])
        .where('tenant_id', '=', access.tenantId).where('tenant_customer_id', '=', id).where('status', '<>', 'draft').orderBy('created_at', 'desc').limit(50).execute(),
      trx.selectFrom('policy_decisions').selectAll().where('tenant_id', '=', access.tenantId).where('scope', '=', 'tenant')
        .where('tenant_customer_id', '=', id).where('status', '=', 'active').orderBy('created_at', 'desc').execute(),
      trx.selectFrom('reviews').select(['id', 'rating', 'comment', 'status', 'business_reply', 'created_at', 'booking_id'])
        .where('tenant_id', '=', access.tenantId).where('tenant_customer_id', '=', id).orderBy('created_at', 'desc').limit(20).execute(),
      effectiveConsents(trx, access.tenantId, [id]),
    ]);
    const incidents = canReview
      ? await trx.selectFrom('customer_incidents').select(['id', 'type', 'status', 'occurred_at']).where('tenant_id', '=', access.tenantId).where('tenant_customer_id', '=', id).orderBy('occurred_at', 'desc').limit(20).execute()
      : undefined;
    const { private_notes, user_id, ...rest } = c;
    return {
      ...rest,
      has_account: user_id !== null,
      ...(canNotes ? { private_notes } : {}),
      bookings: bookings.map((b) => (canFinancial ? b : { ...b, total_minor: undefined, payment_status: undefined })),
      orders: hasCapability(access, 'orders.view') ? orders : [],
      reviews,
      consents: consents.get(id),
      // Members without incidents.review see the effect of a decision, not its reasons or evidence.
      decisions: decisions.map((d) => (canReview ? d : decisionEffect(d))),
      ...(incidents ? { incidents } : {}),
    };
  });
}

export async function createCustomer(access: TenantAccess, actor: AuditActor, input: z.infer<typeof customerCreate>) {
  if (input.private_notes && !hasCapability(access, 'customers.view_notes')) throw Errors.forbidden('You cannot write private notes', { reason: 'notes' });
  const phone = normPhone(input.phone);
  return withTenant(access.tenantId, async (trx) => {
    if (phone) {
      // Only this business's own records are checked; LUMA accounts are never consulted.
      const dup = await trx.selectFrom('tenant_customers').select('id').where('tenant_id', '=', access.tenantId).where('phone', '=', phone).where('status', '=', 'active').executeTakeFirst();
      if (dup) throw Errors.conflict('customer_phone_exists', 'A customer of this business already uses this phone number', { customer_id: dup.id });
    }
    const row = await trx.insertInto('tenant_customers').values({
      tenant_id: access.tenantId, user_id: null, display_name: input.display_name, phone, email: input.email ?? null,
      tags: input.tags, preferences: JSON.stringify(input.preferences), private_notes: input.private_notes ?? null, source: input.source,
    }).returning([...LIST_COLS]).executeTakeFirstOrThrow();
    await audit(trx, actor, 'customer.created', { tenantId: access.tenantId, targetType: 'tenant_customer', targetId: row.id, data: { source: input.source } });
    return { ...row, has_account: false };
  });
}

export async function updateCustomer(access: TenantAccess, actor: AuditActor, id: string, patch: z.infer<typeof customerPatch>) {
  if (patch.private_notes !== undefined && !hasCapability(access, 'customers.view_notes')) throw Errors.forbidden('You cannot edit private notes', { reason: 'notes' });
  const phone = patch.phone !== undefined ? normPhone(patch.phone) : undefined;
  return withTenant(access.tenantId, async (trx) => {
    const cur = await trx.selectFrom('tenant_customers').selectAll().where('tenant_id', '=', access.tenantId).where('id', '=', id).forUpdate().executeTakeFirst();
    if (!cur) throw Errors.notFound('customer');
    if (cur.version !== patch.version) throw Errors.versionConflict(cur.version);
    if (phone && phone !== cur.phone) {
      const dup = await trx.selectFrom('tenant_customers').select('id').where('tenant_id', '=', access.tenantId).where('phone', '=', phone).where('status', '=', 'active').where('id', '<>', id).executeTakeFirst();
      if (dup) throw Errors.conflict('customer_phone_exists', 'A customer of this business already uses this phone number', { customer_id: dup.id });
    }
    const row = await trx.updateTable('tenant_customers').set({
      ...(patch.display_name !== undefined ? { display_name: patch.display_name } : {}),
      ...(phone !== undefined ? { phone } : {}),
      ...(patch.email !== undefined ? { email: patch.email } : {}),
      ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
      ...(patch.preferences !== undefined ? { preferences: JSON.stringify(patch.preferences) } : {}),
      ...(patch.private_notes !== undefined ? { private_notes: patch.private_notes } : {}),
      ...(patch.archived !== undefined ? { status: patch.archived ? 'archived' : 'active', archived_at: patch.archived ? new Date() : null } : {}),
      version: cur.version + 1,
    }).where('id', '=', id).returning([...LIST_COLS]).executeTakeFirstOrThrow();
    const fields = Object.keys(patch).filter((k) => k !== 'version');
    await audit(trx, actor, patch.archived === true ? 'customer.archived' : 'customer.updated', { tenantId: access.tenantId, targetType: 'tenant_customer', targetId: id, data: { fields } });
    return { ...row, has_account: cur.user_id !== null };
  });
}

export async function recordCustomerConsent(access: TenantAccess, actor: AuditActor, id: string, input: z.infer<typeof consentInput>) {
  return withTenant(access.tenantId, async (trx) => {
    const tc = await trx.selectFrom('tenant_customers').select(['id', 'user_id']).where('tenant_id', '=', access.tenantId).where('id', '=', id).executeTakeFirst();
    if (!tc) throw Errors.notFound('customer');
    await recordConsent(trx, { tenantId: access.tenantId, tenantCustomerId: id, userId: tc.user_id, channel: input.channel, purpose: input.purpose, granted: input.granted, source: 'dashboard', recordedBy: actor.userId, actor });
    return (await effectiveConsents(trx, access.tenantId, [id])).get(id);
  });
}

export async function customerTags(access: TenantAccess) {
  return withTenant(access.tenantId, async (trx) => {
    const r = await sql<{ tag: string; n: number }>`select t as tag, count(*)::int as n from tenant_customers, unnest(tags) t where tenant_id = ${access.tenantId} and status = 'active' group by t order by n desc limit 50`.execute(trx);
    return r.rows;
  });
}

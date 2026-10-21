import { sql } from 'kysely';
import type { z } from 'zod';
import { db, withCentral, withSystem, withTenant } from '../../db/client';
import { Errors, isPgCode } from '../../http/errors';
import { audit, type AuditActor } from '../../infra/audit';
import { notifyCapability, notifyUsers } from '../../infra/notify';
import type { SessionUser } from '../../auth/service';
import type { accountConsentInput, accountProfilePatch, reviewInput } from '@/shared/schemas/customers';
import type { appealCreate } from '@/shared/schemas/policy';
import { suppressionHash, effectiveConsents, recordConsent } from './consents';

/**
 * The central customer account (/account). Every read here is filtered by the
 * signed-in user's own id. Cross-business reads use allowlisted SECURITY
 * DEFINER functions or a reasoned system scope with an explicit user filter.
 * A customer never sees other customers, employees, internal reasons,
 * evidence, reviewer identities or another business's reports.
 */

// ── Profile ─────────────────────────────────────────────────────────────────
export async function getProfile(user: SessionUser) {
  const u = await db().selectFrom('users').select(['id', 'display_name', 'email', 'phone', 'email_verified_at', 'phone_verified_at', 'locale', 'time_format', 'created_at'])
    .where('id', '=', user.userId).executeTakeFirstOrThrow();
  return { ...u, email_verified: !!u.email_verified_at, phone_verified: !!u.phone_verified_at };
}

export async function updateProfile(user: SessionUser, actor: AuditActor, patch: z.infer<typeof accountProfilePatch>) {
  await withCentral(async (trx) => {
    await trx.updateTable('users').set({
      ...(patch.display_name !== undefined ? { display_name: patch.display_name } : {}),
      ...(patch.locale ? { locale: patch.locale } : {}),
      ...(patch.time_format ? { time_format: patch.time_format } : {}),
    }).where('id', '=', user.userId).execute();
    await audit(trx, actor, 'account.profile_updated', { targetType: 'user', targetId: user.userId, data: { fields: Object.keys(patch) } });
  });
  return getProfile(user);
}

// ── Bookings & orders across businesses ─────────────────────────────────────
const CLOSED = new Set(['completed', 'cancelled', 'expired', 'no_show']);

export async function listMyBookings(user: SessionUser, scope: 'upcoming' | 'past' | 'all') {
  const r = await sql<{ id: string; tenant_id: string; tenant_slug: string; tenant_name: string; number: string; status: string; payment_status: string; starts_at: Date; ends_at: Date; timezone: string; total_minor: number; currency: string; items: unknown }>`
    select * from app.customer_bookings(${user.userId}, 100, null)`.execute(db());
  const now = Date.now();
  const rows = r.rows.map((b) => ({ ...b, upcoming: b.starts_at.getTime() >= now && !CLOSED.has(b.status), detail_path: `/account/bookings/${b.id}` }));
  const filtered = scope === 'all' ? rows : rows.filter((b) => (scope === 'upcoming' ? b.upcoming : !b.upcoming));
  return scope === 'upcoming' ? filtered.sort((a, b) => a.starts_at.getTime() - b.starts_at.getTime()) : filtered;
}

export async function listMyOrders(user: SessionUser) {
  const r = await sql`select * from app.customer_orders(${user.userId}, 100)`.execute(db());
  return r.rows;
}

// ── Relationships & consents ────────────────────────────────────────────────
async function myRelationships(userId: string) {
  return withSystem('customer reads her own business relationships', (trx) => trx.selectFrom('tenant_customers as c').innerJoin('tenants as t', 't.id', 'c.tenant_id')
    .select(['c.id as tenant_customer_id', 'c.tenant_id', 't.name as tenant_name', 't.slug as tenant_slug'])
    .where('c.user_id', '=', userId).where('c.status', '=', 'active').orderBy('t.name').execute());
}

export async function listMyConsents(user: SessionUser) {
  const rels = await myRelationships(user.userId);
  const out = [];
  for (const r of rels) {
    const map = await withTenant(r.tenant_id, (trx) => effectiveConsents(trx, r.tenant_id, [r.tenant_customer_id]));
    out.push({ ...r, tenant_slug: String(r.tenant_slug), consents: map.get(r.tenant_customer_id) });
  }
  return out;
}

export async function setMyConsent(user: SessionUser, actor: AuditActor, input: z.infer<typeof accountConsentInput>) {
  const rel = (await myRelationships(user.userId)).find((r) => r.tenant_customer_id === input.tenant_customer_id);
  if (!rel) throw Errors.notFound('business');
  return withTenant(rel.tenant_id, async (trx) => {
    await recordConsent(trx, { tenantId: rel.tenant_id, tenantCustomerId: rel.tenant_customer_id, userId: user.userId, channel: input.channel, purpose: input.purpose, granted: input.granted, source: 'account', recordedBy: user.userId, actor });
    // Her own explicit opt-in lifts an earlier unsubscribe suppression.
    if (input.granted && input.purpose === 'marketing' && input.channel !== 'push') {
      const tc = await trx.selectFrom('tenant_customers').select(['email', 'phone']).where('id', '=', rel.tenant_customer_id).executeTakeFirstOrThrow();
      const dest = input.channel === 'email' ? tc.email : tc.phone;
      if (dest) await trx.deleteFrom('suppression_list').where('tenant_id', '=', rel.tenant_id).where('channel', '=', input.channel).where('destination_hash', '=', suppressionHash(input.channel, dest)).where('reason', '=', 'unsubscribed').execute();
    }
    return (await effectiveConsents(trx, rel.tenant_id, [rel.tenant_customer_id])).get(rel.tenant_customer_id);
  });
}

// ── Policy that affects her (effect + customer explanation only) ────────────
export async function myPolicy(user: SessionUser) {
  return withSystem('customer reads decisions and incidents about herself', async (trx) => {
    const decisions = await trx.selectFrom('policy_decisions as d').leftJoin('tenants as t', 't.id', 'd.tenant_id')
      .select(['d.id', 'd.scope', 'd.action', 'd.status', 'd.effective_at', 'd.expires_at', 'd.customer_explanation_ar', 'd.customer_explanation_en', 't.name as tenant_name',
        sql<boolean>`exists (select 1 from appeals a where a.decision_id = d.id and a.customer_user_id = ${user.userId} and a.status in ('submitted','under_review'))`.as('appeal_open')])
      .where('d.customer_user_id', '=', user.userId).where('d.action', '<>', 'default')
      .where((eb) => eb.or([eb('d.status', '=', 'active'), eb('d.ended_at', '>', new Date(Date.now() - 180 * 86_400_000))]))
      .orderBy('d.created_at', 'desc').limit(50).execute();
    // Incidents: type/date/status only — never the free-text description, the
    // submitting employee, evidence, or other customers.
    const incidents = await trx.selectFrom('customer_incidents as i').innerJoin('tenants as t', 't.id', 'i.tenant_id')
      .leftJoin('bookings as b', (j) => j.onRef('b.id', '=', 'i.booking_id').onRef('b.tenant_id', '=', 'i.tenant_id'))
      .select(['i.id', 'i.type', 'i.status', 'i.occurred_at', 't.name as tenant_name', 'b.number as booking_number',
        sql<boolean>`exists (select 1 from appeals a where a.incident_id = i.id and a.customer_user_id = ${user.userId} and a.status in ('submitted','under_review'))`.as('appeal_open')])
      .where('i.customer_user_id', '=', user.userId).where('i.status', 'in', ['confirmed', 'corrected'])
      .orderBy('i.occurred_at', 'desc').limit(50).execute();
    return {
      decisions: decisions.map((d) => ({ ...d, tenant_name: d.scope === 'platform' ? null : d.tenant_name, can_appeal: d.status === 'active' && !d.appeal_open })),
      incidents: incidents.map((i) => ({ ...i, can_appeal: !i.appeal_open })),
    };
  });
}

// ── Appeals ─────────────────────────────────────────────────────────────────
export async function listMyAppeals(user: SessionUser) {
  return withSystem('customer reads her own appeals', (trx) => trx.selectFrom('appeals as a')
    .leftJoin('policy_decisions as d', 'd.id', 'a.decision_id').leftJoin('customer_incidents as i', 'i.id', 'a.incident_id')
    .leftJoin('tenants as t', 't.id', 'a.tenant_id')
    // No reviewer identity, no internal reasons.
    .select(['a.id', 'a.status', 'a.message', 'a.resolution_note', 'a.created_at', 'a.resolved_at', 'a.decision_id', 'a.incident_id', 'a.review_scope',
      'd.action as decision_action', 'i.type as incident_type', 't.name as tenant_name'])
    .where('a.customer_user_id', '=', user.userId).orderBy('a.created_at', 'desc').limit(100).execute());
}

export async function fileAppeal(user: SessionUser, actor: AuditActor, input: z.infer<typeof appealCreate>) {
  return withSystem('customer files an appeal on her own decision or incident', async (trx) => {
    let tenantId: string | null = null;
    let scope: 'tenant' | 'platform' = 'tenant';
    if (input.decision_id) {
      const d = await trx.selectFrom('policy_decisions').select(['id', 'tenant_id', 'scope', 'status']).where('id', '=', input.decision_id).where('customer_user_id', '=', user.userId).executeTakeFirst();
      if (!d) throw Errors.notFound('decision');
      if (d.status !== 'active') throw Errors.conflict('decision_not_active', 'This decision is no longer active');
      tenantId = d.tenant_id;
      scope = d.scope as 'tenant' | 'platform';
    } else {
      const i = await trx.selectFrom('customer_incidents').select(['id', 'tenant_id', 'status']).where('id', '=', input.incident_id!).where('customer_user_id', '=', user.userId).executeTakeFirst();
      if (!i || (i.status !== 'confirmed' && i.status !== 'corrected')) throw Errors.notFound('incident');
      tenantId = i.tenant_id;
    }
    let row;
    try {
      await sql`savepoint appeal_insert`.execute(trx);
      row = await trx.insertInto('appeals').values({
        customer_user_id: user.userId, decision_id: input.decision_id ?? null, incident_id: input.incident_id ?? null,
        tenant_id: scope === 'tenant' ? tenantId : null, review_scope: scope, message: input.message,
      }).returning(['id', 'status', 'created_at', 'review_scope']).executeTakeFirstOrThrow();
    } catch (e) {
      await sql`rollback to savepoint appeal_insert`.execute(trx);
      if (isPgCode(e, '23505')) throw Errors.conflict('appeal_already_open', 'You already have an open review request for this item');
      throw e;
    }
    await audit(trx, actor, 'appeal.submitted', { tenantId: scope === 'tenant' ? tenantId : null, targetType: 'appeal', targetId: row.id, data: { decision_id: input.decision_id ?? null, incident_id: input.incident_id ?? null } });
    if (scope === 'tenant' && tenantId) {
      const t = await trx.selectFrom('tenants').select('slug').where('id', '=', tenantId).executeTakeFirstOrThrow();
      await notifyCapability(trx, tenantId, ['incidents.review'], {
        kind: 'policy.appeal_submitted', title_ar: 'طلب مراجعة جديد من عميلة', title_en: 'New review request from a customer',
        target_path: `/app/${t.slug}/policies?tab=appeals`, dedupe_key: `policy.appeal_submitted:${row.id}`,
      });
    } else {
      const reviewers = await trx.selectFrom('platform_roles').select('user_id').where('role', 'in', ['policy_reviewer', 'platform_owner']).where('revoked_at', 'is', null).execute();
      await notifyUsers(trx, null, reviewers.map((r) => r.user_id), {
        kind: 'policy.appeal_submitted', title_ar: 'طلب مراجعة على قرار لوما', title_en: 'Review request on a LUMA decision', target_path: '/platform/policies', dedupe_key: `policy.appeal_submitted:${row.id}`,
      });
    }
    return row;
  });
}

// ── Reviews ─────────────────────────────────────────────────────────────────
export async function myReviews(user: SessionUser) {
  const pending = (await sql`select * from app.customer_reviewable_bookings(${user.userId}, 50)`.execute(db())).rows;
  const written = await withSystem('customer reads her own reviews', (trx) => trx.selectFrom('reviews as r').innerJoin('tenants as t', 't.id', 'r.tenant_id')
    .select(['r.id', 'r.booking_id', 'r.rating', 'r.comment', 'r.business_reply', 'r.created_at', 't.name as tenant_name',
      // She learns her review is not public, not who moderated it or why.
      sql<boolean>`r.status = 'published'`.as('is_public')])
    .where('r.customer_user_id', '=', user.userId).orderBy('r.created_at', 'desc').limit(100).execute());
  return { pending, written };
}

export async function writeReview(user: SessionUser, actor: AuditActor, input: z.infer<typeof reviewInput>) {
  const b = await withSystem('customer locates her own booking to review', (trx) => trx.selectFrom('bookings').select(['id', 'tenant_id', 'tenant_customer_id', 'status'])
    .where('id', '=', input.booking_id).where('customer_user_id', '=', user.userId).executeTakeFirst());
  if (!b) throw Errors.notFound('booking');
  if (b.status !== 'completed') throw Errors.invalid('review_not_eligible', 'You can review a visit once it is completed');
  return withTenant(b.tenant_id, async (trx) => {
    const staff = await trx.selectFrom('booking_items').select('staff_id').where('booking_id', '=', b.id).orderBy('sequence').executeTakeFirst();
    try {
      await sql`savepoint review_insert`.execute(trx);
      const row = await trx.insertInto('reviews').values({
        tenant_id: b.tenant_id, booking_id: b.id, tenant_customer_id: b.tenant_customer_id, customer_user_id: user.userId,
        staff_id: staff?.staff_id ?? null, rating: input.rating, comment: input.comment?.trim() || null,
      }).returning(['id', 'rating', 'comment', 'status', 'created_at']).executeTakeFirstOrThrow();
      await audit(trx, actor, 'review.created', { tenantId: b.tenant_id, targetType: 'review', targetId: row.id, data: { rating: input.rating } });
      return row;
    } catch (e) {
      await sql`rollback to savepoint review_insert`.execute(trx);
      if (isPgCode(e, '23505')) throw Errors.conflict('review_exists', 'You already reviewed this visit');
      if (isPgCode(e, '23514')) throw Errors.invalid('review_not_eligible', 'You can review a visit once it is completed');
      throw e;
    }
  });
}

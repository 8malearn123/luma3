import { sql } from 'kysely';
import { withSystem } from '../../db/client';
import { Errors } from '../../http/errors';
import { audit, type AuditActor } from '../../infra/audit';
import { notifyCapability } from '../../infra/notify';
import { usageFor } from '../subscriptions/service';

/**
 * LUMA-side view of businesses. Only aggregate and allowlisted fields are
 * returned (name, slug, status, plan, subscription dates, owner contact, counts).
 * Customer records, bookings and notes are never listed here; seeing them
 * requires a reasoned, time-limited support grant.
 */
export type TenantListQuery = { q?: string; status?: string; plan?: string; sub_status?: string; sort: string; page: number; limit: number };

const CURRENT_SUB = sql`
  left join lateral (
    select s.id, s.status, s.trial_ends_at, s.current_period_end, s.grace_until, s.overage_state, s.cancel_at, p.code as plan_code, p.name_ar as plan_name_ar, p.name_en as plan_name_en
    from subscriptions s join plans p on p.id = s.plan_id
    where s.tenant_id = t.id
    order by case when s.status in ('trialing','active','past_due','paused') then 0 else 1 end, s.created_at desc
    limit 1
  ) sub on true
  left join lateral (
    select u.id, u.display_name, u.email::text as email, u.phone from tenant_memberships m join users u on u.id = m.user_id
    where m.tenant_id = t.id and m.role = 'owner' and m.status = 'active' limit 1
  ) own on true`;

export async function listTenants(q: TenantListQuery) {
  return withSystem('platform: list businesses (allowlisted fields)', async (trx) => {
    const where = [sql`true`];
    if (q.q) where.push(sql`(t.name ilike ${`%${q.q}%`} or t.slug::text ilike ${`%${q.q}%`} or own.email ilike ${`%${q.q}%`})`);
    if (q.status) where.push(sql`t.status = ${q.status}`);
    if (q.plan) where.push(sql`sub.plan_code = ${q.plan}`);
    if (q.sub_status) where.push(sql`sub.status = ${q.sub_status}`);
    const cond = sql.join(where, sql` and `);
    const order = q.sort === 'created_asc' ? sql`t.created_at asc` : q.sort === 'name_asc' ? sql`t.name asc` : q.sort === 'trial_end_asc' ? sql`sub.trial_ends_at asc nulls last` : sql`t.created_at desc`;
    const total = await sql<{ n: number }>`select count(*)::int as n from tenants t ${CURRENT_SUB} where ${cond}`.execute(trx);
    const rows = await sql<{
      id: string; slug: string; name: string; status: string; business_type: string; city: string | null; created_at: Date; is_demo: boolean;
      sub_id: string | null; sub_status: string | null; trial_ends_at: Date | null; current_period_end: Date | null; grace_until: Date | null; overage_state: unknown;
      plan_code: string | null; plan_name_ar: string | null; plan_name_en: string | null; owner_name: string | null; owner_email: string | null;
    }>`select t.id, t.slug::text as slug, t.name, t.status, t.business_type, t.city, t.created_at, t.is_demo,
        sub.id as sub_id, sub.status as sub_status, sub.trial_ends_at, sub.current_period_end, sub.grace_until, sub.overage_state,
        sub.plan_code, sub.plan_name_ar, sub.plan_name_en, own.display_name as owner_name, own.email as owner_email
      from tenants t ${CURRENT_SUB} where ${cond} order by ${order}, t.id limit ${q.limit} offset ${(q.page - 1) * q.limit}`.execute(trx);
    return { items: rows.rows, total: total.rows[0]?.n ?? 0, page: q.page, limit: q.limit };
  });
}

export async function tenantDetail(id: string) {
  return withSystem('platform: business detail (aggregates only)', async (trx) => {
    const r = await sql<Record<string, unknown> & { id: string; sub_id: string | null }>`
      select t.id, t.slug::text as slug, t.name, t.status, t.business_type, t.city, t.default_locale, t.timezone, t.created_at, t.is_demo,
        (t.published_version_id is not null) as published,
        sub.id as sub_id, sub.status as sub_status, sub.trial_ends_at, sub.current_period_end, sub.grace_until, sub.cancel_at, sub.overage_state,
        sub.plan_code, sub.plan_name_ar, sub.plan_name_en,
        own.id as owner_id, own.display_name as owner_name, own.email as owner_email, own.phone as owner_phone
      from tenants t ${CURRENT_SUB} where t.id = ${id}`.execute(trx);
    const t = r.rows[0];
    if (!t) throw Errors.notFound('business');
    const usage = await usageFor(trx, id);
    const counts = await sql<{ members: number; bookings_30d: number; bookings_total: number; customers: number }>`
      select (select count(*)::int from tenant_memberships where tenant_id = ${id} and status = 'active') as members,
             (select count(*)::int from bookings where tenant_id = ${id} and created_at > now() - interval '30 days') as bookings_30d,
             (select count(*)::int from bookings where tenant_id = ${id}) as bookings_total,
             (select count(*)::int from tenant_customers where tenant_id = ${id}) as customers`.execute(trx);
    const limits = t.sub_id
      ? await trx.selectFrom('plan_features as f').innerJoin('subscriptions as s', 's.plan_id', 'f.plan_id').select(['f.feature_key', 'f.enabled', 'f.limit_value']).where('s.id', '=', t.sub_id).execute()
      : [];
    const grants = await trx.selectFrom('support_access_grants as g').innerJoin('users as u', 'u.id', 'g.platform_user_id')
      .select(['g.id', 'g.reason', 'g.access_level', 'g.starts_at', 'g.expires_at', 'g.revoked_at', 'u.display_name as support_user'])
      .where('g.tenant_id', '=', id).orderBy('g.created_at', 'desc').limit(10).execute();
    return { tenant: t, usage, counts: counts.rows[0], limits, support_grants: grants };
  });
}

/** Suspension blocks the workspace (capabilities emptied) without touching data. */
export async function setTenantStatus(id: string, actor: AuditActor, input: { status: 'active' | 'suspended'; reason: string }) {
  return withSystem('platform: change business status', async (trx) => {
    const cur = await trx.selectFrom('tenants').select(['id', 'status', 'slug', 'published_version_id']).where('id', '=', id).forUpdate().executeTakeFirst();
    if (!cur) throw Errors.notFound('business');
    if (cur.status === 'closed') throw Errors.conflict('invalid_transition', 'Closed businesses cannot be changed here');
    if (input.status === 'active' && cur.status !== 'suspended') throw Errors.conflict('invalid_transition', 'Only a suspended business can be reinstated');
    if (input.status === 'suspended' && cur.status === 'suspended') throw Errors.conflict('invalid_transition', 'Already suspended');
    // Reinstating returns to 'active' once published, otherwise back to 'onboarding'.
    const next = input.status === 'suspended' ? 'suspended' : cur.published_version_id ? 'active' : 'onboarding';
    await trx.updateTable('tenants').set({ status: next }).where('id', '=', id).execute();
    await audit(trx, actor, input.status === 'suspended' ? 'platform.tenant.suspended' : 'platform.tenant.reinstated', { tenantId: id, targetType: 'tenant', targetId: id, data: { from: cur.status, reason: input.reason } });
    await notifyCapability(trx, id, ['business.manage'], {
      kind: 'tenant.status_changed',
      title_ar: input.status === 'suspended' ? 'تم إيقاف مساحة عملك مؤقتاً من قبل لوما. بياناتك محفوظة.' : 'تمت إعادة تفعيل مساحة عملك.',
      title_en: input.status === 'suspended' ? 'LUMA temporarily suspended your workspace. Your data is kept.' : 'Your workspace was reinstated.',
      body_ar: input.reason, body_en: input.reason,
      target_path: `/app/${cur.slug}`,
    });
    return { id, status: next };
  });
}

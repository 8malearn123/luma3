import type { z } from 'zod';
import { sql, withTenant, type Tx } from '../../db/client';
import { Errors } from '../../http/errors';
import { audit, type AuditActor } from '../../infra/audit';
import { hasCapability, type TenantAccess } from '../../tenancy/access';
import { segmentDefinition, type SegmentCondition, type SegmentDefinition, type segmentInput } from '@/shared/schemas/marketing';
import { cadenceCte } from './snapshot';

/**
 * Explainable audience segments. Definitions are an allowlist of conditions
 * (validated by zod) compiled to parameterised SQL fragments — user input is
 * only ever a bound parameter, never SQL text. Conditions are combined with AND.
 */

const consentChannel = (c: string) => (c === 'in_app' ? 'push' : c);

function conditionSql(tenantId: string, c: SegmentCondition) {
  switch (c.type) {
    case 'last_visit_before_days': return sql`st.last_visit < now() - make_interval(days => ${c.days})`;
    case 'last_visit_within_days': return sql`st.last_visit >= now() - make_interval(days => ${c.days})`;
    case 'visited_service': return sql`exists (select 1 from booking_items bi join bookings b on b.id = bi.booking_id and b.tenant_id = bi.tenant_id
      where b.tenant_id = ${tenantId} and b.tenant_customer_id = tc.id and b.status = 'completed' and bi.service_id = ${c.service_id}::uuid)`;
    case 'not_visited_service': return sql`not exists (select 1 from booking_items bi join bookings b on b.id = bi.booking_id and b.tenant_id = bi.tenant_id
      where b.tenant_id = ${tenantId} and b.tenant_customer_id = tc.id and b.status = 'completed' and bi.service_id = ${c.service_id}::uuid)`;
    case 'due_for_service': return sql`exists (select 1 from due where due.c = tc.id and due.s = ${c.service_id}::uuid)`;
    case 'min_visits': return sql`coalesce(st.visits, 0) >= ${c.count}`;
    case 'has_consent': return sql`(${latestConsentSql(tenantId, consentChannel(c.channel))}) is true`;
    case 'tag': return sql`${c.tag} = any(tc.tags)`;
    case 'never_booked': return sql`coalesce(st.any_bookings, 0) = 0`;
    case 'has_account': return sql`tc.user_id is not null`;
  }
}

/** Latest marketing consent row for this customer (by local record or central account) in this business. */
export function latestConsentSql(tenantId: string, channel: string) {
  return sql`select cc.granted from customer_consents cc
    where cc.tenant_id = ${tenantId} and cc.channel = ${channel} and cc.purpose = 'marketing'
      and (cc.tenant_customer_id = tc.id or (tc.user_id is not null and cc.user_id = tc.user_id))
    order by cc.recorded_at desc limit 1`;
}

export function compileSegment(tenantId: string, def: SegmentDefinition, select = sql`tc.id`) {
  const parsed = segmentDefinition.parse(def);
  const needsDue = parsed.conditions.some((c) => c.type === 'due_for_service');
  const where = sql.join(parsed.conditions.map((c) => conditionSql(tenantId, c)), sql` and `);
  return sql`
    with ${needsDue ? sql`${cadenceCte(tenantId)},` : sql``}
    st as (
      select tenant_customer_id as c,
        count(*) filter (where status = 'completed') as visits,
        max(starts_at) filter (where status = 'completed') as last_visit,
        count(*) filter (where status not in ('draft', 'held', 'expired')) as any_bookings
      from bookings where tenant_id = ${tenantId} group by 1
    )
    select ${select} from tenant_customers tc left join st on st.c = tc.id
    where tc.tenant_id = ${tenantId} and tc.status = 'active' and ${where}`;
}

export function explainSegment(def: SegmentDefinition) {
  return def.conditions.map((c) => ({ type: c.type, params: Object.fromEntries(Object.entries(c).filter(([k]) => k !== 'type')) }));
}

export async function segmentMembers(trx: Tx, tenantId: string, def: SegmentDefinition) {
  const r = await compileSegment(tenantId, def, sql`tc.id, tc.user_id, tc.email::text as email, tc.phone`).execute(trx);
  return r.rows as Array<{ id: string; user_id: string | null; email: string | null; phone: string | null }>;
}

/** Audience preview: counts only, plus a small named sample for customers.view holders. */
export async function previewSegment(access: TenantAccess, def: SegmentDefinition) {
  return withTenant(access.tenantId, async (trx) => {
    const count = await sql<{ n: number }>`select count(*)::int as n from (${compileSegment(access.tenantId, def)}) x`.execute(trx);
    const consented: Record<string, number> = {};
    for (const ch of ['email', 'sms', 'whatsapp', 'in_app'] as const) {
      const withConsent = { conditions: [...def.conditions.filter((c) => c.type !== 'has_consent' || c.channel !== ch), { type: 'has_consent' as const, channel: ch }] };
      const r = await sql<{ n: number }>`select count(*)::int as n from (${compileSegment(access.tenantId, withConsent)}) x`.execute(trx);
      consented[ch] = r.rows[0]!.n;
    }
    let sample: Array<{ id: string; display_name: string }> | undefined;
    if (hasCapability(access, 'customers.view')) {
      const s = await compileSegment(access.tenantId, def, sql`tc.id, tc.display_name`).execute(trx);
      sample = (s.rows as Array<{ id: string; display_name: string }>).slice(0, 10);
    }
    return { count: count.rows[0]!.n, consented_by_channel: consented, explanation: explainSegment(def), ...(sample ? { sample } : {}) };
  });
}

export async function listSegments(access: TenantAccess) {
  return withTenant(access.tenantId, (trx) => trx.selectFrom('campaign_segments').selectAll().where('tenant_id', '=', access.tenantId).orderBy('created_at', 'desc').execute());
}

export async function createSegment(access: TenantAccess, actor: AuditActor, input: z.infer<typeof segmentInput>, trxIn?: Tx) {
  const run = async (trx: Tx) => {
    const row = await trx.insertInto('campaign_segments').values({ tenant_id: access.tenantId, name: input.name, description: input.description ?? null, definition: JSON.stringify(input.definition), created_by: actor.userId })
      .returningAll().executeTakeFirstOrThrow();
    await audit(trx, actor, 'marketing.segment_created', { tenantId: access.tenantId, targetType: 'segment', targetId: row.id });
    return row;
  };
  return trxIn ? run(trxIn) : withTenant(access.tenantId, run);
}

export async function updateSegment(access: TenantAccess, actor: AuditActor, id: string, input: z.infer<typeof segmentInput>) {
  return withTenant(access.tenantId, async (trx) => {
    const used = await trx.selectFrom('campaigns').select('id').where('segment_id', '=', id).where('status', 'in', ['approved', 'scheduled', 'sending']).executeTakeFirst();
    if (used) throw Errors.conflict('segment_in_use', 'An approved or scheduled campaign uses this segment');
    const row = await trx.updateTable('campaign_segments').set({ name: input.name, description: input.description ?? null, definition: JSON.stringify(input.definition) })
      .where('id', '=', id).returningAll().executeTakeFirst();
    if (!row) throw Errors.notFound('segment');
    await audit(trx, actor, 'marketing.segment_updated', { tenantId: access.tenantId, targetType: 'segment', targetId: id });
    return row;
  });
}

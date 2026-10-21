import { sql } from 'kysely';
import { withSystem } from '../../db/client';
import { env } from '../../env';
import { decodeCursor, encodeCursor } from '../../http/route';
import { channelStatus } from '../../infra/messaging';
import { aiStatus } from '../../infra/ai';
import type { PlatformCapability } from '../../auth/capabilities';

/** Actions considered sensitive for the dashboard feed and the audit filter. */
export const SENSITIVE_ACTION_PREFIXES = ['platform.', 'auth.password', 'subscription.', 'settings.booking_policy', 'member', 'invitation', 'refund', 'payment', 'policy.'];

// ── Integrations & errors (honest status) ───────────────────────────────────
export async function integrationsStatus() {
  return withSystem('platform: integration health (aggregates)', async (trx) => {
    const lastAi = await trx.selectFrom('ai_runs').select(sql<Date | null>`max(created_at)`.as('at')).where('status', '=', 'succeeded').executeTakeFirst();
    const ai = await aiStatus(lastAi?.at ?? null);
    const ai24 = await sql<{ status: string; n: number }>`select status, count(*)::int as n from ai_runs where created_at > now() - interval '24 hours' group by status`.execute(trx);
    const payments = await sql<{ provider: string; mode: string; status: string; n: number }>`select provider, mode, status, count(*)::int as n from payment_accounts group by provider, mode, status order by provider, mode`.execute(trx);
    const jobs = await sql<{ kind: string; failed_24h: number; failed_7d: number; queued: number; running: number }>`
      select kind,
        count(*) filter (where status = 'failed' and coalesce(finished_at, created_at) > now() - interval '24 hours')::int as failed_24h,
        count(*) filter (where status = 'failed' and coalesce(finished_at, created_at) > now() - interval '7 days')::int as failed_7d,
        count(*) filter (where status = 'queued')::int as queued,
        count(*) filter (where status = 'running')::int as running
      from job_runs group by kind having count(*) filter (where status in ('failed','queued','running')) > 0 order by failed_24h desc, kind limit 50`.execute(trx);
    const recentFailures = await trx.selectFrom('job_runs').select(['id', 'kind', 'attempts', 'last_error', 'finished_at', 'created_at']).where('status', '=', 'failed')
      .orderBy('created_at', 'desc').limit(10).execute();
    const outbox = await sql<{ pending: number; oldest: Date | null; erroring: number }>`
      select count(*)::int as pending, min(created_at) as oldest, count(*) filter (where last_error is not null)::int as erroring
      from outbox_events where processed_at is null`.execute(trx);
    const providerEvents = await sql<{ needs_review: number; failed: number; invalid_signature_7d: number }>`
      select count(*) filter (where status = 'needs_review')::int as needs_review, count(*) filter (where status = 'failed')::int as failed,
             count(*) filter (where not signature_valid and received_at > now() - interval '7 days')::int as invalid_signature_7d
      from provider_events`.execute(trx);
    const deliveries = await sql<{ channel: string; status: string; n: number }>`
      select channel, status, count(*)::int as n from notification_deliveries where created_at > now() - interval '7 days' group by channel, status`.execute(trx);
    return {
      messaging: { email: channelStatus('email'), sms: channelStatus('sms'), whatsapp: channelStatus('whatsapp') },
      ai: { status: ai, last_success_at: lastAi?.at ?? null, last_24h: ai24.rows },
      payments: { accounts: payments.rows, live_accounts: payments.rows.filter((r) => r.mode === 'live').reduce((a, r) => a + r.n, 0), sandbox_accounts: payments.rows.filter((r) => r.mode === 'test').reduce((a, r) => a + r.n, 0) },
      storage: { driver: env().STORAGE_DRIVER },
      jobs: { by_kind: jobs.rows, recent_failures: recentFailures.map((j) => ({ ...j, last_error: j.last_error?.slice(0, 300) ?? null })) },
      outbox: outbox.rows[0],
      provider_events: providerEvents.rows[0],
      deliveries_7d: deliveries.rows,
    };
  });
}

// ── AI usage & cost ─────────────────────────────────────────────────────────
/** Per tenant/month; cost only where cost_usd_micros was recorded, otherwise reported as unknown. */
export async function aiUsage(q: { months: number; q?: string }) {
  return withSystem('platform: AI usage aggregates', async (trx) => {
    const rows = await sql<{ tenant_id: string; slug: string; name: string; month: string; runs: number; succeeded: number; failed: number; input_tokens: number | null; output_tokens: number | null; cost_usd_micros: number | null; runs_with_cost: number }>`
      select r.tenant_id, t.slug::text as slug, t.name, to_char(date_trunc('month', r.created_at), 'YYYY-MM') as month,
        count(*)::int as runs, count(*) filter (where r.status = 'succeeded')::int as succeeded, count(*) filter (where r.status <> 'succeeded')::int as failed,
        sum(r.input_tokens)::bigint as input_tokens, sum(r.output_tokens)::bigint as output_tokens,
        sum(r.cost_usd_micros)::bigint as cost_usd_micros, count(r.cost_usd_micros)::int as runs_with_cost
      from ai_runs r join tenants t on t.id = r.tenant_id
      where r.created_at >= date_trunc('month', now()) - make_interval(months => ${q.months - 1})
        ${q.q ? sql`and (t.name ilike ${`%${q.q}%`} or t.slug::text ilike ${`%${q.q}%`})` : sql``}
      group by r.tenant_id, t.slug, t.name, month order by month desc, runs desc limit 500`.execute(trx);
    const items = rows.rows.map((r) => ({ ...r, cost_status: r.runs_with_cost === 0 ? 'unknown' : r.runs_with_cost < r.runs ? 'partial' : 'known' }));
    const totals = items.reduce((a, r) => ({ runs: a.runs + r.runs, succeeded: a.succeeded + r.succeeded, cost_usd_micros: a.cost_usd_micros + (r.cost_usd_micros ?? 0), runs_with_cost: a.runs_with_cost + r.runs_with_cost }), { runs: 0, succeeded: 0, cost_usd_micros: 0, runs_with_cost: 0 });
    return { items, totals: { ...totals, cost_status: totals.runs_with_cost === 0 ? 'unknown' : totals.runs_with_cost < totals.runs ? 'partial' : 'known' }, pricing_configured: env().OPENAI_PRICE_INPUT_PER_MTOK != null && env().OPENAI_PRICE_OUTPUT_PER_MTOK != null };
  });
}

// ── LUMA subscription revenue (separate from salon sales) ───────────────────
export async function revenue(q: { months: number }) {
  return withSystem('platform: LUMA subscription revenue', async (trx) => {
    const monthly = await sql<{ month: string; paid_minor: number; open_minor: number; void_minor: number; invoices: number; currency: string }>`
      select to_char(date_trunc('month', coalesce(paid_at, issued_at, created_at)), 'YYYY-MM') as month,
        coalesce(sum(amount_minor) filter (where status = 'paid'), 0)::bigint as paid_minor,
        coalesce(sum(amount_minor) filter (where status = 'open'), 0)::bigint as open_minor,
        coalesce(sum(amount_minor) filter (where status = 'void'), 0)::bigint as void_minor,
        count(*)::int as invoices, currency
      from platform_invoices
      where coalesce(paid_at, issued_at, created_at) >= date_trunc('month', now()) - make_interval(months => ${q.months - 1})
      group by month, currency order by month desc`.execute(trx);
    const byPlan = await sql<{ code: string; name_ar: string; name_en: string; price_monthly_minor: number | null; price_is_test: boolean; active: number; trialing: number; past_due: number }>`
      select p.code, p.name_ar, p.name_en, p.price_monthly_minor, p.price_is_test,
        count(s.id) filter (where s.status = 'active')::int as active, count(s.id) filter (where s.status = 'trialing')::int as trialing,
        count(s.id) filter (where s.status = 'past_due')::int as past_due
      from plans p left join subscriptions s on s.plan_id = p.id group by p.id order by p.sort`.execute(trx);
    const mrr = byPlan.rows.reduce((a, p) => a + (p.price_monthly_minor ?? 0) * p.active, 0);
    const unpriced = byPlan.rows.filter((p) => p.price_monthly_minor === null).reduce((a, p) => a + p.active, 0);
    return {
      is_test: true,
      monthly: monthly.rows,
      by_plan: byPlan.rows,
      estimated_mrr_minor: mrr,
      active_on_unpriced_plans: unpriced,
      note: 'LUMA subscription invoices only (test mode). Salon sales and customer payments are not included.',
    };
  });
}

export async function listInvoices(q: { status?: string; page: number; limit: number }) {
  return withSystem('platform: list LUMA invoices', async (trx) => {
    let base = trx.selectFrom('platform_invoices as i').innerJoin('tenants as t', 't.id', 'i.tenant_id').leftJoin('plans as p', 'p.id', 'i.plan_id');
    if (q.status) base = base.where('i.status', '=', q.status);
    const total = await base.select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow();
    const items = await base.select(['i.id', 'i.number', 'i.amount_minor', 'i.currency', 'i.status', 'i.period_start', 'i.period_end', 'i.issued_at', 'i.paid_at', 'i.is_test', 'i.subscription_id', 'i.note',
      sql<string>`t.slug::text`.as('tenant_slug'), 't.name as tenant_name', 'p.code as plan_code'])
      .orderBy('i.created_at', 'desc').limit(q.limit).offset((q.page - 1) * q.limit).execute();
    return { items, total: total.n, page: q.page, limit: q.limit };
  });
}

// ── Platform audit search ───────────────────────────────────────────────────
export async function platformAudit(q: { tenant?: string; actor?: string; action?: string; actor_kind?: string; from?: string; to?: string; sensitive_only?: '0' | '1'; limit: number; cursor?: string }) {
  const cur = decodeCursor<{ t: string; id: string }>(q.cursor);
  return withSystem('platform: audit search', async (trx) => {
    let base = trx.selectFrom('audit_logs as a').leftJoin('users as u', 'u.id', 'a.actor_user_id').leftJoin('tenants as t', 't.id', 'a.tenant_id');
    if (q.tenant) base = base.where(sql<string>`t.slug::text`, '=', q.tenant);
    if (q.actor) base = /^[0-9a-f-]{36}$/i.test(q.actor) ? base.where('a.actor_user_id', '=', q.actor) : base.where((eb) => eb.or([eb(sql<string>`u.email::text`, 'ilike', q.actor!), eb('u.phone', '=', q.actor!), eb('u.display_name', 'ilike', `%${q.actor}%`)]));
    if (q.action) base = base.where('a.action', 'like', `${q.action}%`);
    if (q.actor_kind) base = base.where('a.actor_kind', '=', q.actor_kind);
    if (q.from) base = base.where('a.created_at', '>=', new Date(`${q.from}T00:00:00Z`));
    if (q.to) base = base.where('a.created_at', '<', new Date(new Date(`${q.to}T00:00:00Z`).getTime() + 86_400_000));
    if (q.sensitive_only === '1') base = base.where((eb) => eb.or([...SENSITIVE_ACTION_PREFIXES.map((p) => eb('a.action', 'like', `${p}%`)), eb('a.support_grant_id', 'is not', null)]));
    if (cur) base = base.where(sql<boolean>`(a.created_at, a.id) < (${new Date(cur.t)}, ${cur.id}::uuid)`);
    const rows = await base.select(['a.id', 'a.action', 'a.actor_kind', 'a.actor_user_id', 'a.support_grant_id', 'a.target_type', 'a.target_id', 'a.request_id', 'a.ip', 'a.data', 'a.created_at',
      'u.display_name as actor_name', sql<string | null>`u.email::text`.as('actor_email'), sql<string | null>`t.slug::text`.as('tenant_slug'), 't.name as tenant_name'])
      .orderBy('a.created_at', 'desc').orderBy('a.id', 'desc').limit(q.limit + 1).execute();
    const more = rows.length > q.limit;
    const items = rows.slice(0, q.limit);
    const last = items[items.length - 1];
    return { items, next_cursor: more && last ? encodeCursor({ t: last.created_at.toISOString(), id: last.id }) : null };
  });
}

// ── Dashboard home ──────────────────────────────────────────────────────────
export async function platformOverview(caps: Set<PlatformCapability>) {
  const base = await withSystem('platform: dashboard counts', async (trx) => {
    const tenants = await sql<{ status: string; n: number }>`select status, count(*)::int as n from tenants group by status`.execute(trx);
    const subs = await sql<{ status: string; n: number }>`select status, count(*)::int as n from subscriptions group by status`.execute(trx);
    const ending = await trx.selectFrom('subscriptions as s').innerJoin('tenants as t', 't.id', 's.tenant_id')
      .select(['s.id', 's.trial_ends_at', sql<string>`t.slug::text`.as('slug'), 't.name', 't.id as tenant_id'])
      .where('s.status', '=', 'trialing').where('s.trial_ends_at', '<=', new Date(Date.now() + 7 * 86_400_000)).orderBy('s.trial_ends_at').limit(10).execute();
    const pastDue = await trx.selectFrom('subscriptions as s').innerJoin('tenants as t', 't.id', 's.tenant_id')
      .select(['s.id', 's.grace_until', sql<string>`t.slug::text`.as('slug'), 't.name', 't.id as tenant_id'])
      .where('s.status', '=', 'past_due').orderBy('s.grace_until').limit(10).execute();
    const activeGrants = await trx.selectFrom('support_access_grants').select(sql<number>`count(*)::int`.as('n')).where('revoked_at', 'is', null).where('expires_at', '>', new Date()).executeTakeFirstOrThrow();
    return {
      tenants_by_status: Object.fromEntries(tenants.rows.map((r) => [r.status, r.n])),
      subscriptions_by_status: Object.fromEntries(subs.rows.map((r) => [r.status, r.n])),
      trials_ending_soon: ending, past_due: pastDue, active_support_grants: activeGrants.n,
    };
  });
  const health = caps.has('platform.integrations.view') ? await integrationsStatus() : null;
  const recent = caps.has('platform.audit.view') ? (await platformAudit({ sensitive_only: '1', limit: 10 })).items : null;
  return {
    ...base,
    health: health && {
      messaging: health.messaging, ai: health.ai.status.state, storage: health.storage.driver,
      failed_jobs_24h: health.jobs.by_kind.reduce((a, j) => a + j.failed_24h, 0), outbox_pending: health.outbox?.pending ?? 0,
      provider_events_needing_review: health.provider_events?.needs_review ?? 0, live_payment_accounts: health.payments.live_accounts,
    },
    recent_sensitive: recent,
  };
}

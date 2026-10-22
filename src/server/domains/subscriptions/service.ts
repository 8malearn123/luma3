import { sql } from 'kysely';
import { withSystem, withTenant, type Tx } from '../../db/client';
import { AppError, Errors } from '../../http/errors';
import { audit, type AuditActor } from '../../infra/audit';
import { notifyCapability } from '../../infra/notify';
import type { TenantAccess } from '../../tenancy/access';
import { PLAN_FEATURES, type PlanLimitKey } from '@/shared/plans';

/**
 * LUMA subscriptions (the business's plan with LUMA). Completely independent
 * of customer payments to salons: nothing here reads or writes `payments`.
 *
 * States: trialing → active ⇄ past_due (grace) → expired; paused; cancelled.
 * Downgrades never delete data: limits that the business is above are recorded
 * in subscriptions.overage_state, and creation of those resources is blocked
 * server-side (requireWithinLimit) until the business is back within limits.
 */
export const CURRENT_STATUSES = ['trialing', 'active', 'past_due', 'paused'] as const;
export const LIMIT_KEYS = (Object.keys(PLAN_FEATURES) as Array<keyof typeof PLAN_FEATURES>).filter((k): k is PlanLimitKey => k.startsWith('limit.'));

export type Usage = Record<PlanLimitKey, number>;
export type Overage = { key: PlanLimitKey; limit: number; used: number };
export type OverageState = { computed_at: string; exceeded: Overage[] } | null;

/** Current counts for every plan limit (inside a tenant- or system-scoped transaction). */
export async function usageFor(trx: Tx, tenantId: string): Promise<Usage> {
  const r = await sql<Record<string, number>>`
    select
      (select count(*)::int from branches where tenant_id = ${tenantId} and status = 'active') as "limit.branches",
      (select count(*)::int from staff_profiles where tenant_id = ${tenantId} and archived_at is null and is_active) as "limit.staff",
      (select count(*)::int from services where tenant_id = ${tenantId} and archived_at is null) as "limit.services",
      (select count(*)::int from products where tenant_id = ${tenantId} and status <> 'archived') as "limit.products",
      (select count(*)::int from store_pages where tenant_id = ${tenantId} and kind = 'custom' and status = 'active') as "limit.custom_pages",
      (select count(*)::int from ai_runs where tenant_id = ${tenantId} and status = 'succeeded' and created_at >= date_trunc('month', now())) as "limit.ai_runs_monthly"
  `.execute(trx);
  const row = r.rows[0] ?? {};
  return Object.fromEntries(LIMIT_KEYS.map((k) => [k, Number(row[k] ?? 0)])) as Usage;
}

export async function planFeatures(trx: Tx, planId: string) {
  const rows = await trx.selectFrom('plan_features').selectAll().where('plan_id', '=', planId).execute();
  return new Map(rows.map((r) => [r.feature_key, { enabled: r.enabled, limit: r.limit_value }]));
}

/** Limits the usage exceeds under a plan's features (a disabled limit counts as 0). */
export function overagesFor(usage: Usage, features: Map<string, { enabled: boolean; limit: number | null }>): Overage[] {
  const out: Overage[] = [];
  for (const key of LIMIT_KEYS) {
    if (key === 'limit.ai_runs_monthly') continue; // monthly allowance resets; not a stored-data overage
    const f = features.get(key);
    const limit = !f || !f.enabled ? 0 : f.limit;
    if (limit !== null && usage[key] > limit) out.push({ key, limit, used: usage[key] });
  }
  return out;
}

export function overageState(exceeded: Overage[]): OverageState {
  return exceeded.length ? { computed_at: new Date().toISOString(), exceeded } : null;
}

/** Recomputes and stores overage_state for a subscription (no-op when unchanged). */
export async function recomputeOverage(trx: Tx, sub: { id: string; tenant_id: string; plan_id: string; overage_state: unknown }) {
  const exceeded = overagesFor(await usageFor(trx, sub.tenant_id), await planFeatures(trx, sub.plan_id));
  const prev = (sub.overage_state as OverageState)?.exceeded ?? [];
  const same = JSON.stringify(prev.map((o) => [o.key, o.limit, o.used])) === JSON.stringify(exceeded.map((o) => [o.key, o.limit, o.used]));
  if (!same) await trx.updateTable('subscriptions').set({ overage_state: overageState(exceeded) ? JSON.stringify(overageState(exceeded)) : null }).where('id', '=', sub.id).execute();
  return exceeded;
}

async function currentSubscription(trx: Tx, tenantId: string, lock = false) {
  let q = trx.selectFrom('subscriptions').selectAll().where('tenant_id', '=', tenantId)
    .orderBy(sql`case when status in ('trialing','active','past_due','paused') then 0 else 1 end`).orderBy('created_at', 'desc');
  if (lock) q = q.forUpdate();
  return q.executeTakeFirst();
}

async function recordEvent(trx: Tx, e: { tenantId: string; subscriptionId: string; kind: string; from?: string | null; to?: string | null; actorUserId: string | null; data?: Record<string, unknown> }) {
  await trx.insertInto('subscription_events').values({
    tenant_id: e.tenantId, subscription_id: e.subscriptionId, kind: e.kind, from_status: e.from ?? null, to_status: e.to ?? null,
    actor_user_id: e.actorUserId, data: JSON.stringify(e.data ?? {}),
  }).execute();
}

function addCycle(from: Date, cycle: string) {
  const d = new Date(from);
  if (cycle === 'yearly') d.setUTCFullYear(d.getUTCFullYear() + 1);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return d;
}

function serializePlan(p: { id: string; code: string; name_ar: string; name_en: string; description_ar: string | null; description_en: string | null; price_monthly_minor: number | null; price_yearly_minor: number | null; price_is_test: boolean; currency: string; trial_days: number; grace_days: number; sort: number; status: string }) {
  return {
    id: p.id, code: p.code, name_ar: p.name_ar, name_en: p.name_en, description_ar: p.description_ar, description_en: p.description_en,
    price_monthly_minor: p.price_monthly_minor, price_yearly_minor: p.price_yearly_minor, price_is_test: p.price_is_test,
    pricing_configured: p.price_monthly_minor !== null, currency: p.currency, trial_days: p.trial_days, grace_days: p.grace_days, sort: p.sort, status: p.status,
  };
}

// ── Owner side ──────────────────────────────────────────────────────────────
/** Plan, status, dates, usage vs limits, available plans, history and test invoices. */
export async function getSubscriptionOverview(access: TenantAccess) {
  return withTenant(access.tenantId, async (trx) => {
    const sub = await currentSubscription(trx, access.tenantId);
    const plans = await trx.selectFrom('plans').selectAll().where('status', '=', 'active').orderBy('sort').execute();
    const allFeatures = await trx.selectFrom('plan_features').selectAll().execute();
    const usage = await usageFor(trx, access.tenantId);
    if (!sub) return { subscription: null, usage: LIMIT_KEYS.map((k) => ({ key: k, used: usage[k], limit: 0, enabled: false })), plans: [], events: [], invoices: [] };
    const plan = await trx.selectFrom('plans').selectAll().where('id', '=', sub.plan_id).executeTakeFirstOrThrow();
    const features = await planFeatures(trx, sub.plan_id);
    const exceeded = overagesFor(usage, features);
    const events = await trx.selectFrom('subscription_events').select(['id', 'kind', 'from_status', 'to_status', 'data', 'created_at'])
      .where('subscription_id', '=', sub.id).orderBy('created_at', 'desc').limit(30).execute();
    const invoices = await trx.selectFrom('platform_invoices').select(['id', 'number', 'amount_minor', 'currency', 'status', 'period_start', 'period_end', 'issued_at', 'paid_at', 'is_test'])
      .where('tenant_id', '=', access.tenantId).orderBy('created_at', 'desc').limit(24).execute();
    return {
      subscription: {
        id: sub.id, status: sub.status, billing_cycle: sub.billing_cycle, trial_ends_at: sub.trial_ends_at, current_period_start: sub.current_period_start,
        current_period_end: sub.current_period_end, grace_until: sub.grace_until, cancel_at: sub.cancel_at, cancelled_at: sub.cancelled_at, paused_at: sub.paused_at,
        overage_state: overageState(exceeded), read_only: access.readOnly, plan: serializePlan(plan),
      },
      usage: LIMIT_KEYS.map((k) => {
        const f = features.get(k);
        return { key: k, used: usage[k], limit: f?.enabled ? f.limit : 0, enabled: !!f?.enabled };
      }),
      plans: plans.map((p) => ({
        ...serializePlan(p),
        features: Object.fromEntries(allFeatures.filter((f) => f.plan_id === p.id).map((f) => [f.feature_key, { enabled: f.enabled, limit: f.limit_value }])),
      })),
      events, invoices,
    };
  });
}

async function loadTargetPlan(trx: Tx, code: string) {
  const p = await trx.selectFrom('plans').selectAll().where('code', '=', code).where('status', '=', 'active').executeTakeFirst();
  if (!p) throw Errors.invalid('plan_unavailable', 'The selected plan is not available');
  return p;
}

export async function previewPlanChange(access: TenantAccess, planCode: string) {
  return withTenant(access.tenantId, async (trx) => {
    const sub = await currentSubscription(trx, access.tenantId);
    if (!sub || !CURRENT_STATUSES.includes(sub.status as (typeof CURRENT_STATUSES)[number])) throw Errors.conflict('no_active_subscription', 'There is no current subscription to change');
    const [from, to] = await Promise.all([trx.selectFrom('plans').selectAll().where('id', '=', sub.plan_id).executeTakeFirstOrThrow(), loadTargetPlan(trx, planCode)]);
    const overages = overagesFor(await usageFor(trx, access.tenantId), await planFeatures(trx, to.id));
    return { from: from.code, to: to.code, direction: to.sort > from.sort ? 'upgrade' : to.sort < from.sort ? 'downgrade' : 'same', overages, requires_confirmation: overages.length > 0 };
  });
}

/**
 * Upgrades apply immediately. A downgrade that leaves the business above the
 * new limits requires explicit confirmation; nothing is deleted — the overage
 * is recorded and creating more of those resources is blocked until resolved.
 */
export async function changePlan(access: TenantAccess, actor: AuditActor, input: { plan_code: string; confirm_overage?: boolean }) {
  return withTenant(access.tenantId, async (trx) => {
    const sub = await currentSubscription(trx, access.tenantId, true);
    if (!sub || !CURRENT_STATUSES.includes(sub.status as (typeof CURRENT_STATUSES)[number])) throw Errors.conflict('no_active_subscription', 'There is no current subscription to change');
    const from = await trx.selectFrom('plans').selectAll().where('id', '=', sub.plan_id).executeTakeFirstOrThrow();
    const to = await loadTargetPlan(trx, input.plan_code);
    if (to.id === from.id) throw Errors.invalid('same_plan', 'This is already your plan');
    const overages = overagesFor(await usageFor(trx, access.tenantId), await planFeatures(trx, to.id));
    if (overages.length && !input.confirm_overage) {
      throw new AppError(409, 'downgrade_confirmation_required', 'This plan has lower limits than what you currently use. Confirm to continue; no data will be deleted.', { overages });
    }
    const direction = to.sort > from.sort ? 'upgrade' : 'downgrade';
    const state = overageState(overages);
    await trx.updateTable('subscriptions').set({ plan_id: to.id, overage_state: state ? JSON.stringify(state) : null, version: sql`version + 1` }).where('id', '=', sub.id).execute();
    await recordEvent(trx, { tenantId: access.tenantId, subscriptionId: sub.id, kind: 'plan_changed', from: sub.status, to: sub.status, actorUserId: actor.userId, data: { from_plan: from.code, to_plan: to.code, direction, overages } });
    await audit(trx, actor, 'subscription.plan_changed', { tenantId: access.tenantId, targetType: 'subscription', targetId: sub.id, data: { from_plan: from.code, to_plan: to.code, direction, overage_keys: overages.map((o) => o.key) } });
    return { plan: to.code, direction, overage_state: state };
  });
}

export async function setCancelAtPeriodEnd(access: TenantAccess, actor: AuditActor, cancel: boolean) {
  return withTenant(access.tenantId, async (trx) => {
    const sub = await currentSubscription(trx, access.tenantId, true);
    if (!sub || !CURRENT_STATUSES.includes(sub.status as (typeof CURRENT_STATUSES)[number])) throw Errors.conflict('no_active_subscription', 'There is no current subscription');
    const at = cancel ? (sub.current_period_end ?? sub.trial_ends_at ?? new Date()) : null;
    await trx.updateTable('subscriptions').set({ cancel_at: at, version: sql`version + 1` }).where('id', '=', sub.id).execute();
    await recordEvent(trx, { tenantId: access.tenantId, subscriptionId: sub.id, kind: cancel ? 'cancel_scheduled' : 'cancel_unscheduled', from: sub.status, to: sub.status, actorUserId: actor.userId, data: { cancel_at: at?.toISOString() ?? null } });
    await audit(trx, actor, cancel ? 'subscription.cancel_scheduled' : 'subscription.cancel_unscheduled', { tenantId: access.tenantId, targetType: 'subscription', targetId: sub.id });
    return { cancel_at: at };
  });
}

// ── Platform side ───────────────────────────────────────────────────────────
type SubRow = NonNullable<Awaited<ReturnType<typeof currentSubscription>>>;

async function lockSub(trx: Tx, id: string): Promise<SubRow> {
  const sub = await trx.selectFrom('subscriptions').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
  if (!sub) throw Errors.notFound('subscription');
  return sub;
}

function invalidTransition(from: string, action: string) {
  return Errors.conflict('invalid_transition', `Cannot ${action} a ${from} subscription`, { from, action });
}

/**
 * Platform-owner lifecycle actions (step-up enforced by the route). Every
 * change appends a subscription_event and an audit record visible to the
 * business in its own audit log.
 */
export async function platformSubscriptionAction(id: string, actor: AuditActor, input: { action: string; days?: number; plan_code?: string; reason: string }) {
  return withSystem('platform subscription lifecycle action', async (trx) => {
    const sub = await lockSub(trx, id);
    const plan = await trx.selectFrom('plans').selectAll().where('id', '=', sub.plan_id).executeTakeFirstOrThrow();
    const now = new Date();
    const s = sub.status;
    let patch: Record<string, unknown> = {};
    let to = s;
    const data: Record<string, unknown> = { reason: input.reason };
    switch (input.action) {
      case 'activate':
      case 'reactivate': {
        if (s === 'active') throw invalidTransition(s, input.action);
        if (s === 'cancelled' || s === 'expired') {
          const other = await trx.selectFrom('subscriptions').select('id').where('tenant_id', '=', sub.tenant_id).where('id', '<>', sub.id)
            .where('status', 'in', [...CURRENT_STATUSES]).executeTakeFirst();
          if (other) throw Errors.conflict('another_subscription_current', 'The business already has a current subscription');
        }
        to = 'active';
        patch = { status: 'active', current_period_start: now, current_period_end: addCycle(now, sub.billing_cycle), grace_until: null, paused_at: null, cancel_at: null, cancelled_at: null };
        break;
      }
      case 'extend_trial': {
        if (!input.days) throw Errors.invalid('days_required', 'Number of days is required');
        if (!['trialing', 'past_due', 'expired'].includes(s)) throw invalidTransition(s, input.action);
        const base = sub.trial_ends_at && sub.trial_ends_at > now ? sub.trial_ends_at : now;
        const ends = new Date(base.getTime() + input.days * 86_400_000);
        to = 'trialing';
        patch = { status: 'trialing', trial_ends_at: ends, current_period_end: ends, grace_until: null };
        data.days = input.days; data.trial_ends_at = ends.toISOString();
        break;
      }
      case 'set_grace': {
        if (!input.days) throw Errors.invalid('days_required', 'Number of days is required');
        if (s !== 'past_due') throw invalidTransition(s, input.action);
        const until = new Date(now.getTime() + input.days * 86_400_000);
        patch = { grace_until: until };
        data.days = input.days; data.grace_until = until.toISOString();
        break;
      }
      case 'mark_past_due': {
        if (!['active', 'trialing'].includes(s)) throw invalidTransition(s, input.action);
        to = 'past_due';
        patch = { status: 'past_due', grace_until: new Date(now.getTime() + plan.grace_days * 86_400_000) };
        break;
      }
      case 'pause': {
        if (!['active', 'trialing', 'past_due'].includes(s)) throw invalidTransition(s, input.action);
        to = 'paused';
        patch = { status: 'paused', paused_at: now };
        break;
      }
      case 'resume': {
        if (s !== 'paused') throw invalidTransition(s, input.action);
        to = sub.trial_ends_at && sub.trial_ends_at > now ? 'trialing' : 'active';
        patch = { status: to, paused_at: null, ...(to === 'active' ? { current_period_start: now, current_period_end: addCycle(now, sub.billing_cycle), grace_until: null } : {}) };
        break;
      }
      case 'cancel': {
        if (s === 'cancelled' || s === 'expired') throw invalidTransition(s, input.action);
        to = 'cancelled';
        patch = { status: 'cancelled', cancelled_at: now };
        break;
      }
      case 'expire': {
        if (s === 'cancelled' || s === 'expired') throw invalidTransition(s, input.action);
        to = 'expired';
        patch = { status: 'expired' };
        break;
      }
      case 'change_plan': {
        if (!input.plan_code) throw Errors.invalid('plan_required', 'Choose a plan');
        const target = await loadTargetPlan(trx, input.plan_code);
        if (target.id === plan.id) throw Errors.invalid('same_plan', 'This is already the plan');
        const exceeded = overagesFor(await usageFor(trx, sub.tenant_id), await planFeatures(trx, target.id));
        const st = overageState(exceeded);
        patch = { plan_id: target.id, overage_state: st ? JSON.stringify(st) : null };
        data.from_plan = plan.code; data.to_plan = target.code; data.overages = exceeded;
        break;
      }
      default:
        throw Errors.invalid('invalid_action');
    }
    await trx.updateTable('subscriptions').set({ ...patch, version: sql`version + 1` }).where('id', '=', sub.id).execute();
    await recordEvent(trx, { tenantId: sub.tenant_id, subscriptionId: sub.id, kind: `platform.${input.action}`, from: s, to, actorUserId: actor.userId, data });
    await audit(trx, actor, `platform.subscription.${input.action}`, { tenantId: sub.tenant_id, targetType: 'subscription', targetId: sub.id, data: { from: s, to, ...data } });
    if (to !== s) {
      await notifyCapability(trx, sub.tenant_id, ['subscription.view', 'subscription.manage'], {
        kind: 'subscription.status_changed',
        title_ar: `تغيّرت حالة اشتراكك في لوما إلى: ${STATUS_AR[to] ?? to}`,
        title_en: `Your LUMA subscription status changed to: ${to}`,
        target_path: await settingsPath(trx, sub.tenant_id),
      });
    }
    return trx.selectFrom('subscriptions').selectAll().where('id', '=', sub.id).executeTakeFirstOrThrow();
  });
}

export const STATUS_AR: Record<string, string> = { trialing: 'فترة تجريبية', active: 'نشط', past_due: 'متأخر السداد', paused: 'موقوف مؤقتاً', cancelled: 'ملغى', expired: 'منتهٍ' };

async function settingsPath(trx: Tx, tenantId: string) {
  const t = await trx.selectFrom('tenants').select('slug').where('id', '=', tenantId).executeTakeFirst();
  return t ? `/app/${t.slug}/settings?tab=subscription` : undefined;
}

export async function platformListSubscriptions(q: { status?: string; trial_ending_days?: number; q?: string; page: number; limit: number }) {
  return withSystem('platform: list subscriptions (aggregate fields only)', async (trx) => {
    let base = trx.selectFrom('subscriptions as s').innerJoin('tenants as t', 't.id', 's.tenant_id').innerJoin('plans as p', 'p.id', 's.plan_id');
    if (q.status) base = base.where('s.status', '=', q.status);
    if (q.trial_ending_days) base = base.where('s.status', '=', 'trialing').where('s.trial_ends_at', '<=', new Date(Date.now() + q.trial_ending_days * 86_400_000));
    if (q.q) base = base.where((eb) => eb.or([eb('t.name', 'ilike', `%${q.q}%`), eb(sql<string>`t.slug::text`, 'ilike', `%${q.q}%`)]));
    const total = await base.select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow();
    const rows = await base.select(['s.id', 's.status', 's.billing_cycle', 's.trial_ends_at', 's.current_period_end', 's.grace_until', 's.cancel_at', 's.paused_at', 's.overage_state', 's.created_at',
      't.id as tenant_id', 't.slug', 't.name as tenant_name', 'p.code as plan_code', 'p.name_ar as plan_name_ar', 'p.name_en as plan_name_en'])
      .orderBy(sql`case s.status when 'past_due' then 0 when 'trialing' then 1 else 2 end`).orderBy('s.trial_ends_at', 'asc').orderBy('s.created_at', 'desc')
      .limit(q.limit).offset((q.page - 1) * q.limit).execute();
    return { items: rows, total: total.n, page: q.page, limit: q.limit };
  });
}

export async function platformSubscriptionDetail(id: string) {
  return withSystem('platform: subscription detail', async (trx) => {
    const s = await trx.selectFrom('subscriptions as s').innerJoin('tenants as t', 't.id', 's.tenant_id').innerJoin('plans as p', 'p.id', 's.plan_id')
      .selectAll('s').select(['t.slug', 't.name as tenant_name', 'p.code as plan_code', 'p.name_ar as plan_name_ar', 'p.name_en as plan_name_en', 'p.grace_days', 'p.price_monthly_minor', 'p.price_yearly_minor', 'p.price_is_test'])
      .where('s.id', '=', id).executeTakeFirst();
    if (!s) throw Errors.notFound('subscription');
    const events = await trx.selectFrom('subscription_events as e').leftJoin('users as u', 'u.id', 'e.actor_user_id')
      .select(['e.id', 'e.kind', 'e.from_status', 'e.to_status', 'e.data', 'e.created_at', 'u.display_name as actor_name'])
      .where('e.subscription_id', '=', id).orderBy('e.created_at', 'desc').limit(100).execute();
    const invoices = await trx.selectFrom('platform_invoices').selectAll().where('subscription_id', '=', id).orderBy('created_at', 'desc').limit(50).execute();
    const usage = await usageFor(trx, s.tenant_id);
    return { subscription: s, events, invoices, usage };
  });
}

// ── Test-mode billing (no real charging) ─────────────────────────────────────
export async function issueTestInvoice(trx: Tx, sub: SubRow, actorUserId: string | null, note?: string) {
  const plan = await trx.selectFrom('plans').selectAll().where('id', '=', sub.plan_id).executeTakeFirstOrThrow();
  const amount = sub.billing_cycle === 'yearly' ? plan.price_yearly_minor : plan.price_monthly_minor;
  if (amount === null) throw Errors.invalid('pricing_not_configured', 'This plan has no price configured; no invoice can be issued');
  const seq = await sql<{ n: number }>`select nextval('platform_invoice_number_seq')::int as n`.execute(trx);
  const start = sub.current_period_end && sub.current_period_end > new Date() ? (sub.current_period_start ?? new Date()) : (sub.current_period_end ?? new Date());
  const end = addCycle(start, sub.billing_cycle);
  const inv = await trx.insertInto('platform_invoices').values({
    tenant_id: sub.tenant_id, subscription_id: sub.id, plan_id: plan.id, number: `LUMA-TEST-${new Date().getUTCFullYear()}-${String(seq.rows[0]!.n).padStart(6, '0')}`,
    amount_minor: amount, currency: plan.currency, status: 'open', period_start: start.toISOString().slice(0, 10), period_end: end.toISOString().slice(0, 10),
    issued_at: new Date(), is_test: true, note: note ?? null,
  }).returningAll().executeTakeFirstOrThrow();
  await recordEvent(trx, { tenantId: sub.tenant_id, subscriptionId: sub.id, kind: 'test_invoice_issued', from: sub.status, to: sub.status, actorUserId, data: { invoice: inv.number, amount_minor: amount, is_test: true } });
  return inv;
}

export async function platformIssueInvoice(subscriptionId: string, actor: AuditActor, note?: string) {
  return withSystem('platform: issue test invoice', async (trx) => {
    const sub = await lockSub(trx, subscriptionId);
    const inv = await issueTestInvoice(trx, sub, actor.userId, note);
    await audit(trx, actor, 'platform.invoice.issued_test', { tenantId: sub.tenant_id, targetType: 'platform_invoice', targetId: inv.id, data: { number: inv.number, amount_minor: inv.amount_minor } });
    return inv;
  });
}

/**
 * Manual test settlement by the platform owner. Marking paid reactivates a
 * past_due/expired subscription for a new period (no money moves anywhere).
 */
export async function platformMarkInvoice(invoiceId: string, actor: AuditActor, input: { action: 'mark_paid' | 'void'; note?: string }) {
  return withSystem('platform: settle test invoice', async (trx) => {
    const inv = await trx.selectFrom('platform_invoices').selectAll().where('id', '=', invoiceId).forUpdate().executeTakeFirst();
    if (!inv) throw Errors.notFound('invoice');
    if (inv.status !== 'open' && inv.status !== 'draft') throw Errors.conflict('invoice_not_open', 'Only open invoices can be changed');
    const now = new Date();
    if (input.action === 'void') {
      await trx.updateTable('platform_invoices').set({ status: 'void', note: input.note ?? inv.note }).where('id', '=', inv.id).execute();
    } else {
      await trx.updateTable('platform_invoices').set({ status: 'paid', paid_at: now, marked_paid_by: actor.userId, note: input.note ?? inv.note }).where('id', '=', inv.id).execute();
      if (inv.subscription_id) {
        const sub = await lockSub(trx, inv.subscription_id);
        if (['past_due', 'expired', 'trialing'].includes(sub.status)) {
          const other = sub.status === 'expired'
            ? await trx.selectFrom('subscriptions').select('id').where('tenant_id', '=', sub.tenant_id).where('id', '<>', sub.id).where('status', 'in', [...CURRENT_STATUSES]).executeTakeFirst()
            : undefined;
          if (!other) {
            const start = inv.period_start ? new Date(`${inv.period_start}T00:00:00Z`) : now;
            const end = inv.period_end ? new Date(`${inv.period_end}T00:00:00Z`) : addCycle(now, sub.billing_cycle);
            await trx.updateTable('subscriptions').set({ status: 'active', current_period_start: start < now ? now : start, current_period_end: end > now ? end : addCycle(now, sub.billing_cycle), grace_until: null, version: sql`version + 1` })
              .where('id', '=', sub.id).execute();
            await recordEvent(trx, { tenantId: sub.tenant_id, subscriptionId: sub.id, kind: 'test_payment_recorded', from: sub.status, to: 'active', actorUserId: actor.userId, data: { invoice: inv.number, is_test: true } });
          }
        } else {
          await recordEvent(trx, { tenantId: sub.tenant_id, subscriptionId: sub.id, kind: 'test_payment_recorded', from: sub.status, to: sub.status, actorUserId: actor.userId, data: { invoice: inv.number, is_test: true } });
        }
      }
    }
    await audit(trx, actor, input.action === 'void' ? 'platform.invoice.voided' : 'platform.invoice.marked_paid_test', { tenantId: inv.tenant_id, targetType: 'platform_invoice', targetId: inv.id, data: { number: inv.number } });
    return trx.selectFrom('platform_invoices').selectAll().where('id', '=', inv.id).executeTakeFirstOrThrow();
  });
}

// ── Lifecycle sweep (worker; also callable from tests) ──────────────────────
/**
 * Moves subscriptions through time-based transitions:
 *  - trial ended → past_due with grace (plan.grace_days);
 *  - past_due and grace over → expired (workspace read-only, data intact);
 *  - active period ended → cancelled if cancellation was scheduled; otherwise,
 *    in test mode, a labelled test invoice is issued and the subscription waits
 *    in past_due for manual settlement (no real charging); plans without a
 *    configured price simply roll to the next period unbilled.
 */
export async function runSubscriptionLifecycle(now = new Date()) {
  return withSystem('subscription lifecycle sweep', async (trx) => {
    const counts = { trial_ended: 0, grace_expired: 0, cancelled: 0, invoiced: 0, rolled_over: 0 };
    const due = await trx.selectFrom('subscriptions as s').innerJoin('plans as p', 'p.id', 's.plan_id')
      .selectAll('s').select(['p.grace_days'])
      .where((eb) => eb.or([
        eb.and([eb('s.status', '=', 'trialing'), eb('s.trial_ends_at', '<=', now)]),
        eb.and([eb('s.status', '=', 'past_due'), eb('s.grace_until', '<=', now)]),
        eb.and([eb('s.status', '=', 'active'), eb('s.current_period_end', '<=', now)]),
        eb.and([eb('s.status', 'in', ['trialing', 'active', 'past_due']), eb('s.cancel_at', '<=', now)]),
      ]))
      .forUpdate('s').skipLocked().limit(500).execute();
    for (const sub of due) {
      if (sub.cancel_at && sub.cancel_at <= now) {
        await trx.updateTable('subscriptions').set({ status: 'cancelled', cancelled_at: now, version: sql`version + 1` }).where('id', '=', sub.id).execute();
        await recordEvent(trx, { tenantId: sub.tenant_id, subscriptionId: sub.id, kind: 'cancelled_at_period_end', from: sub.status, to: 'cancelled', actorUserId: null });
        counts.cancelled++;
      } else if (sub.status === 'trialing') {
        const grace = new Date((sub.trial_ends_at ?? now).getTime() + sub.grace_days * 86_400_000);
        await trx.updateTable('subscriptions').set({ status: 'past_due', grace_until: grace, version: sql`version + 1` }).where('id', '=', sub.id).execute();
        await recordEvent(trx, { tenantId: sub.tenant_id, subscriptionId: sub.id, kind: 'trial_ended', from: 'trialing', to: 'past_due', actorUserId: null, data: { grace_until: grace.toISOString() } });
        await notifyCapability(trx, sub.tenant_id, ['subscription.manage'], {
          kind: 'subscription.trial_ended', dedupe_key: `trial_ended:${sub.id}`,
          title_ar: 'انتهت الفترة التجريبية. لديكِ فترة سماح قبل أن تصبح المساحة للقراءة فقط.',
          title_en: 'Your trial has ended. You have a grace period before the workspace becomes read-only.',
          target_path: await settingsPath(trx, sub.tenant_id),
        });
        counts.trial_ended++;
      } else if (sub.status === 'past_due') {
        await trx.updateTable('subscriptions').set({ status: 'expired', version: sql`version + 1` }).where('id', '=', sub.id).execute();
        await recordEvent(trx, { tenantId: sub.tenant_id, subscriptionId: sub.id, kind: 'grace_expired', from: 'past_due', to: 'expired', actorUserId: null });
        await notifyCapability(trx, sub.tenant_id, ['subscription.manage'], {
          kind: 'subscription.expired', dedupe_key: `expired:${sub.id}:${now.toISOString().slice(0, 10)}`,
          title_ar: 'انتهى الاشتراك. بياناتك محفوظة والمساحة للقراءة فقط حتى إعادة التفعيل.',
          title_en: 'Your subscription expired. Your data is kept; the workspace is read-only until reactivated.',
          target_path: await settingsPath(trx, sub.tenant_id),
        });
        counts.grace_expired++;
      } else if (sub.status === 'active') {
        const plan = await trx.selectFrom('plans').select(['price_monthly_minor', 'price_yearly_minor']).where('id', '=', sub.plan_id).executeTakeFirstOrThrow();
        const price = sub.billing_cycle === 'yearly' ? plan.price_yearly_minor : plan.price_monthly_minor;
        if (price === null) {
          const start = sub.current_period_end ?? now;
          const end = addCycle(start, sub.billing_cycle);
          await trx.updateTable('subscriptions').set({ current_period_start: start, current_period_end: end, version: sql`version + 1` }).where('id', '=', sub.id).execute();
          await recordEvent(trx, { tenantId: sub.tenant_id, subscriptionId: sub.id, kind: 'period_renewed_unbilled', from: 'active', to: 'active', actorUserId: null, data: { reason: 'pricing_not_configured', period_end: end.toISOString() } });
          counts.rolled_over++;
        } else {
          await issueTestInvoice(trx, sub, null, 'Automatic renewal (test mode)');
          const grace = new Date(now.getTime() + sub.grace_days * 86_400_000);
          await trx.updateTable('subscriptions').set({ status: 'past_due', grace_until: grace, version: sql`version + 1` }).where('id', '=', sub.id).execute();
          await recordEvent(trx, { tenantId: sub.tenant_id, subscriptionId: sub.id, kind: 'renewal_awaiting_payment', from: 'active', to: 'past_due', actorUserId: null, data: { grace_until: grace.toISOString(), is_test: true } });
          counts.invoiced++;
        }
      }
    }
    return counts;
  });
}

/** Monthly usage snapshots + overage_state refresh (keeps transition states accurate). */
export async function maintainUsageCounters(now = new Date()) {
  return withSystem('usage counter maintenance', async (trx) => {
    const period = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
    const subs = await trx.selectFrom('subscriptions').select(['id', 'tenant_id', 'plan_id', 'overage_state']).where('status', 'in', [...CURRENT_STATUSES]).limit(5000).execute();
    for (const sub of subs) {
      const usage = await usageFor(trx, sub.tenant_id);
      const rows = LIMIT_KEYS.map((k) => ({ tenant_id: sub.tenant_id, metric: k, period_start: period, value: usage[k] }));
      await trx.insertInto('usage_counters').values(rows).onConflict((oc) => oc.columns(['tenant_id', 'metric', 'period_start']).doUpdateSet((eb) => ({ value: eb.ref('excluded.value') }))).execute();
      const exceeded = overagesFor(usage, await planFeatures(trx, sub.plan_id));
      const prev = (sub.overage_state as OverageState)?.exceeded ?? [];
      if (JSON.stringify(prev.map((o) => [o.key, o.limit, o.used])) !== JSON.stringify(exceeded.map((o) => [o.key, o.limit, o.used]))) {
        const st = overageState(exceeded);
        await trx.updateTable('subscriptions').set({ overage_state: st ? JSON.stringify(st) : null }).where('id', '=', sub.id).execute();
      }
    }
    return { tenants: subs.length };
  });
}

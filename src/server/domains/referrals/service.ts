import { randomInt } from 'node:crypto';
import { sql } from 'kysely';
import type { z } from 'zod';
import { withSystem, withTenant, type Tx } from '../../db/client';
import { env } from '../../env';
import { AppError, Errors, isPgCode } from '../../http/errors';
import { audit, type AuditActor } from '../../infra/audit';
import type { TenantAccess } from '../../tenancy/access';
import { REFERRAL_CODE_RE, type marketerCreateInput, type referrerUpdateInput, type withdrawalRequestInput } from '@/shared/schemas/admin';
import { readPlatformSettings } from '../platform/settings';

/**
 * Referrals & marketers (affiliates). A referrer is a LUMA marketer or a
 * business (experts refer experts). When a referred business pays its first
 * LUMA invoice, the referrer earns a withdrawable cash reward: rate_bp
 * (per referrer, else the global setting referral_default_rate_bp, default
 * 10%) of the first paid month. Balances live in the append-only
 * referral_ledger; a withdrawal request holds the amount, a rejection
 * releases it, and the platform marks approved withdrawals paid.
 */
export const REFERRAL_COOKIE = 'luma_ref';
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function newReferralCode(len = 8) {
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return s;
}

export function referralLink(code: string) {
  return `${env().APP_URL.replace(/\/$/, '')}/r/${encodeURIComponent(code)}`;
}

/** Normalises a code from a query string, cookie or form; invalid input → null (never an error at signup). */
export function cleanReferralCode(v: string | null | undefined) {
  const c = v?.trim();
  return c && REFERRAL_CODE_RE.test(c) ? c : null;
}

type Referrer = { id: string; kind: string; tenant_id: string | null; code: string; display_name: string; user_id: string | null; rate_bp: number | null; status: string; created_by: string | null };

/** Looks a code up across all referrers (system scope: marketers have no tenant). */
export async function resolveReferralCode(code: string | null | undefined): Promise<(Referrer & { tenant_owner: string | null }) | null> {
  const c = cleanReferralCode(code);
  if (!c) return null;
  return withSystem('referrals: resolve code at signup', async (trx) => {
    const r = await trx.selectFrom('referrers as r').leftJoin('tenants as t', 't.id', 'r.tenant_id')
      .select(['r.id', 'r.kind', 'r.tenant_id', sql<string>`r.code::text`.as('code'), 'r.display_name', 'r.user_id', 'r.rate_bp', 'r.status', 'r.created_by', 't.created_by as tenant_owner'])
      .where(sql<string>`r.code::text`, 'ilike', c).executeTakeFirst();
    return r && r.status === 'active' ? r : null;
  });
}

/**
 * Inside the create-business transaction: links the new business to its
 * referrer. Self-referrals (the referrer's own account or business owner) are
 * ignored silently, as are unknown codes.
 */
export async function recordReferral(trx: Tx, ref: Awaited<ReturnType<typeof resolveReferralCode>>, input: { tenantId: string; tenantName: string; userId: string; channel: 'code' | 'link' }) {
  if (!ref) return null;
  if (ref.user_id === input.userId || ref.tenant_owner === input.userId) return null;
  const r = await trx.insertInto('referrals').values({ referrer_id: ref.id, referred_tenant_id: input.tenantId, referred_name: input.tenantName, channel: input.channel })
    .returning(['id']).executeTakeFirstOrThrow();
  return { id: r.id, referrer_id: ref.id, code: ref.code };
}

async function balances(trx: Tx, referrerIds: string[]) {
  if (!referrerIds.length) return new Map<string, { balance: number; earned: number; withdrawn: number; held: number }>();
  const rows = await sql<{ referrer_id: string; balance: number; earned: number; held: number }>`
    select referrer_id, coalesce(sum(amount_minor), 0)::bigint as balance,
      coalesce(sum(amount_minor) filter (where kind = 'reward'), 0)::bigint as earned,
      coalesce(-sum(amount_minor) filter (where kind in ('withdrawal_hold', 'withdrawal_release')), 0)::bigint as held
    from referral_ledger where referrer_id = any(${referrerIds}::uuid[]) group by referrer_id`.execute(trx);
  const paid = await sql<{ referrer_id: string; paid: number }>`
    select referrer_id, coalesce(sum(amount_minor), 0)::bigint as paid from referral_withdrawals
    where status = 'paid' and referrer_id = any(${referrerIds}::uuid[]) group by referrer_id`.execute(trx);
  const out = new Map<string, { balance: number; earned: number; withdrawn: number; held: number }>();
  for (const id of referrerIds) {
    const b = rows.rows.find((r) => r.referrer_id === id);
    const p = paid.rows.find((r) => r.referrer_id === id)?.paid ?? 0;
    // held = all net holds (pending + paid); in-flight = held - paid.
    out.set(id, { balance: b?.balance ?? 0, earned: b?.earned ?? 0, withdrawn: p, held: Math.max(0, (b?.held ?? 0) - p) });
  }
  return out;
}

export async function balanceOf(trx: Tx, referrerId: string) {
  return (await balances(trx, [referrerId])).get(referrerId)!;
}

/**
 * Called when a platform invoice is marked paid (system scope). Rewards the
 * referrer once, on the referred business's FIRST paid invoice: rate × the
 * monthly amount actually paid (a yearly invoice counts as 1/12).
 */
export async function rewardReferralForPaidInvoice(trx: Tx, inv: { id: string; tenant_id: string; subscription_id: string | null; amount_minor: number; status: string }) {
  if (inv.status !== 'paid') return null;
  const ref = await trx.selectFrom('referrals').selectAll().where('referred_tenant_id', '=', inv.tenant_id).forUpdate().executeTakeFirst();
  if (!ref || ref.status !== 'pending') return null;
  const referrer = await trx.selectFrom('referrers').select(['id', 'rate_bp', 'status']).where('id', '=', ref.referrer_id).executeTakeFirstOrThrow();
  if (referrer.status !== 'active') return null;
  const cycle = inv.subscription_id
    ? (await trx.selectFrom('subscriptions').select('billing_cycle').where('id', '=', inv.subscription_id).executeTakeFirst())?.billing_cycle ?? 'monthly'
    : 'monthly';
  const monthly = cycle === 'yearly' ? Math.round(inv.amount_minor / 12) : inv.amount_minor;
  const rate = referrer.rate_bp ?? (await readPlatformSettings(trx)).referral_default_rate_bp;
  const reward = Math.round((monthly * rate) / 10_000);
  await trx.updateTable('referrals').set({ status: 'rewarded', rate_bp: rate, reward_minor: reward, invoice_id: inv.id, rewarded_at: new Date() }).where('id', '=', ref.id).execute();
  if (reward > 0) {
    await trx.insertInto('referral_ledger').values({ referrer_id: ref.referrer_id, kind: 'reward', amount_minor: reward, referral_id: ref.id, note: `First paid month of ${ref.referred_name}` }).execute();
  }
  await audit(trx, { userId: null, kind: 'system' }, 'referral.rewarded', { targetType: 'referral', targetId: ref.id, data: { referrer_id: ref.referrer_id, invoice_id: inv.id, rate_bp: rate, reward_minor: reward } });
  return { referral_id: ref.id, reward_minor: reward };
}

// ── Withdrawals (shared by the business screen and the platform) ────────────
async function requestWithdrawalTx(trx: Tx, referrerId: string, input: z.infer<typeof withdrawalRequestInput>, userId: string | null) {
  // Lock the referrer row so two concurrent requests cannot both spend the same balance.
  const r = await trx.selectFrom('referrers').select(['id', 'status']).where('id', '=', referrerId).forUpdate().executeTakeFirst();
  if (!r) throw Errors.notFound('referrer');
  if (r.status !== 'active') throw Errors.forbidden('This referral account is suspended', { reason: 'referrer_suspended' });
  const settings = await readPlatformSettings(trx);
  if (input.amount_minor < settings.referral_min_withdrawal_minor) {
    throw Errors.invalid('withdrawal_below_minimum', 'The amount is below the minimum withdrawal', { min_minor: settings.referral_min_withdrawal_minor });
  }
  const b = await balanceOf(trx, referrerId);
  if (input.amount_minor > b.balance) throw new AppError(409, 'insufficient_balance', 'The amount is more than the available balance', { balance_minor: b.balance });
  const w = await trx.insertInto('referral_withdrawals').values({
    referrer_id: referrerId, amount_minor: input.amount_minor, iban: input.iban, account_name: input.account_name, requested_by: userId,
  }).returningAll().executeTakeFirstOrThrow();
  await trx.insertInto('referral_ledger').values({ referrer_id: referrerId, kind: 'withdrawal_hold', amount_minor: -input.amount_minor, withdrawal_id: w.id, created_by: userId }).execute();
  return w;
}

const maskIban = (iban: string) => `${iban.slice(0, 4)}••••${iban.slice(-4)}`;

// ── Business side: «الإحالة» ────────────────────────────────────────────────
async function ensureBusinessReferrer(trx: Tx, access: TenantAccess) {
  const cur = await trx.selectFrom('referrers').selectAll().where('tenant_id', '=', access.tenantId).executeTakeFirst();
  if (cur) return cur;
  for (let i = 0; i < 5; i++) {
    try {
      return await trx.insertInto('referrers').values({ kind: 'business', tenant_id: access.tenantId, code: newReferralCode(), display_name: access.name })
        .onConflict((oc) => oc.column('tenant_id').where('tenant_id', 'is not', null).doNothing())
        .returningAll().executeTakeFirstOrThrow();
    } catch (e) {
      if (!isPgCode(e, '23505') && !(e instanceof Error && /no result/i.test(e.message))) throw e;
      const again = await trx.selectFrom('referrers').selectAll().where('tenant_id', '=', access.tenantId).executeTakeFirst();
      if (again) return again;
    }
  }
  throw Errors.conflict('referral_code_unavailable', 'Could not create a referral code, try again');
}

export async function businessReferralOverview(access: TenantAccess) {
  return withTenant(access.tenantId, async (trx) => {
    const r = await ensureBusinessReferrer(trx, access);
    const settings = await readPlatformSettings(trx);
    // referrals / ledger / withdrawals are central tables: always filtered by this business's referrer id.
    const referred = await trx.selectFrom('referrals').select(['id', 'referred_name', 'status', 'reward_minor', 'rewarded_at', 'created_at'])
      .where('referrer_id', '=', r.id).orderBy('created_at', 'desc').limit(200).execute();
    const withdrawals = await trx.selectFrom('referral_withdrawals').select(['id', 'amount_minor', 'currency', 'iban', 'account_name', 'status', 'reject_reason', 'paid_at', 'created_at'])
      .where('referrer_id', '=', r.id).orderBy('created_at', 'desc').limit(50).execute();
    const ledger = await trx.selectFrom('referral_ledger').select(['id', 'kind', 'amount_minor', 'note', 'created_at']).where('referrer_id', '=', r.id).orderBy('created_at', 'desc').limit(50).execute();
    return {
      code: r.code, link: referralLink(r.code), status: r.status,
      rate_bp: r.rate_bp ?? settings.referral_default_rate_bp, min_withdrawal_minor: settings.referral_min_withdrawal_minor,
      balance: await balanceOf(trx, r.id),
      referred, ledger,
      withdrawals: withdrawals.map((w) => ({ ...w, iban: maskIban(w.iban) })),
    };
  });
}

export async function businessRequestWithdrawal(access: TenantAccess, actor: AuditActor, input: z.infer<typeof withdrawalRequestInput>) {
  return withTenant(access.tenantId, async (trx) => {
    const r = await ensureBusinessReferrer(trx, access);
    const w = await requestWithdrawalTx(trx, r.id, input, actor.userId);
    await audit(trx, actor, 'referral.withdrawal_requested', { tenantId: access.tenantId, targetType: 'referral_withdrawal', targetId: w.id, data: { amount_minor: w.amount_minor } });
    return { ...w, iban: maskIban(w.iban) };
  });
}

// ── Platform side ───────────────────────────────────────────────────────────
export async function referralsOverview(q: { kind?: 'marketer' | 'business' } = {}) {
  return withSystem('platform: referrals leaderboard', async (trx) => {
    let base = trx.selectFrom('referrers as r').leftJoin('tenants as t', 't.id', 'r.tenant_id');
    if (q.kind) base = base.where('r.kind', '=', q.kind);
    const rows = await base.select(['r.id', 'r.kind', sql<string>`r.code::text`.as('code'), 'r.display_name', sql<string | null>`r.contact_email::text`.as('contact_email'), 'r.contact_phone', 'r.rate_bp', 'r.iban', 'r.status', 'r.version', 'r.created_at',
      sql<string | null>`t.slug::text`.as('tenant_slug'), 't.name as tenant_name',
      sql<number>`(select count(*)::int from referrals x where x.referrer_id = r.id)`.as('referred_count'),
      sql<number>`(select count(*)::int from referrals x where x.referrer_id = r.id and x.status = 'rewarded')`.as('converted_count')])
      .orderBy('r.created_at', 'desc').limit(500).execute();
    const b = await balances(trx, rows.map((r) => r.id));
    const settings = await readPlatformSettings(trx);
    const items = rows.map((r) => ({ ...r, iban: r.iban ? maskIban(r.iban) : null, link: referralLink(r.code), effective_rate_bp: r.rate_bp ?? settings.referral_default_rate_bp, ...b.get(r.id)! }));
    const leaderboard = [...items].sort((a, b2) => b2.earned - a.earned || b2.converted_count - a.converted_count || b2.referred_count - a.referred_count).slice(0, 20);
    return { items, leaderboard, default_rate_bp: settings.referral_default_rate_bp, min_withdrawal_minor: settings.referral_min_withdrawal_minor };
  });
}

export async function createMarketer(actor: AuditActor, input: z.infer<typeof marketerCreateInput>) {
  return withSystem('platform: create marketer', async (trx) => {
    try {
      const r = await trx.insertInto('referrers').values({
        kind: 'marketer', code: input.code ?? newReferralCode(), display_name: input.display_name, contact_email: input.contact_email ?? null,
        contact_phone: input.contact_phone ?? null, rate_bp: input.rate_bp ?? null, iban: input.iban ?? null, created_by: actor.userId,
      }).returningAll().executeTakeFirstOrThrow();
      await audit(trx, actor, 'platform.referrer.created', { targetType: 'referrer', targetId: r.id, data: { code: r.code, rate_bp: r.rate_bp } });
      return { ...r, link: referralLink(r.code) };
    } catch (e) {
      if (isPgCode(e, '23505')) throw Errors.conflict('referral_code_taken', 'This code is already used');
      throw e;
    }
  });
}

export async function updateReferrer(id: string, actor: AuditActor, input: z.infer<typeof referrerUpdateInput>) {
  return withSystem('platform: update referrer', async (trx) => {
    const cur = await trx.selectFrom('referrers').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
    if (!cur) throw Errors.notFound('referrer');
    if (cur.version !== input.version) throw Errors.versionConflict(cur.version);
    const { version: _v, ...fields } = input;
    const r = await trx.updateTable('referrers').set({ ...fields, version: cur.version + 1 }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
    await audit(trx, actor, 'platform.referrer.updated', { targetType: 'referrer', targetId: id, data: { fields: Object.keys(fields), rate_bp: fields.rate_bp } });
    return r;
  });
}

export async function referrerDetail(id: string) {
  return withSystem('platform: referrer detail', async (trx) => {
    const r = await trx.selectFrom('referrers').selectAll().where('id', '=', id).executeTakeFirst();
    if (!r) throw Errors.notFound('referrer');
    const referred = await trx.selectFrom('referrals as x').innerJoin('tenants as t', 't.id', 'x.referred_tenant_id')
      .select(['x.id', 'x.referred_name', 'x.status', 'x.rate_bp', 'x.reward_minor', 'x.rewarded_at', 'x.created_at', sql<string>`t.slug::text`.as('tenant_slug'), 't.id as tenant_id'])
      .where('x.referrer_id', '=', id).orderBy('x.created_at', 'desc').limit(200).execute();
    const ledger = await trx.selectFrom('referral_ledger').selectAll().where('referrer_id', '=', id).orderBy('created_at', 'desc').limit(200).execute();
    return { referrer: { ...r, iban: r.iban ? maskIban(r.iban) : null, link: referralLink(r.code) }, balance: await balanceOf(trx, id), referred, ledger };
  });
}

export async function platformRequestWithdrawal(referrerId: string, actor: AuditActor, input: z.infer<typeof withdrawalRequestInput>) {
  return withSystem('platform: withdrawal on behalf of a marketer', async (trx) => {
    const w = await requestWithdrawalTx(trx, referrerId, input, actor.userId);
    await audit(trx, actor, 'platform.referral.withdrawal_requested', { targetType: 'referral_withdrawal', targetId: w.id, data: { referrer_id: referrerId, amount_minor: w.amount_minor } });
    return { ...w, iban: maskIban(w.iban) };
  });
}

export async function adjustReferralBalance(referrerId: string, actor: AuditActor, input: { amount_minor: number; note: string }) {
  return withSystem('platform: referral balance adjustment', async (trx) => {
    const r = await trx.selectFrom('referrers').select('id').where('id', '=', referrerId).forUpdate().executeTakeFirst();
    if (!r) throw Errors.notFound('referrer');
    const b = await balanceOf(trx, referrerId);
    if (b.balance + input.amount_minor < 0) throw new AppError(409, 'insufficient_balance', 'The adjustment would make the balance negative', { balance_minor: b.balance });
    await trx.insertInto('referral_ledger').values({ referrer_id: referrerId, kind: 'adjustment', amount_minor: input.amount_minor, note: input.note, created_by: actor.userId }).execute();
    await audit(trx, actor, 'platform.referral.adjusted', { targetType: 'referrer', targetId: referrerId, data: { amount_minor: input.amount_minor, note: input.note } });
    return balanceOf(trx, referrerId);
  });
}

export async function listWithdrawals(q: { status?: string; page: number; limit: number }) {
  return withSystem('platform: referral withdrawals', async (trx) => {
    let base = trx.selectFrom('referral_withdrawals as w').innerJoin('referrers as r', 'r.id', 'w.referrer_id');
    if (q.status) base = base.where('w.status', '=', q.status);
    const total = await base.select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow();
    const items = await base.select(['w.id', 'w.amount_minor', 'w.currency', 'w.iban', 'w.account_name', 'w.status', 'w.reject_reason', 'w.paid_at', 'w.paid_reference', 'w.decided_at', 'w.created_at',
      'r.id as referrer_id', 'r.kind as referrer_kind', 'r.display_name as referrer_name', sql<string>`r.code::text`.as('referrer_code')])
      .orderBy(sql`case w.status when 'requested' then 0 when 'approved' then 1 else 2 end`).orderBy('w.created_at', 'desc')
      .limit(q.limit).offset((q.page - 1) * q.limit).execute();
    // The full IBAN is shown to the platform owner only on this payout queue (needed to pay).
    return { items, total: total.n, page: q.page, limit: q.limit };
  });
}

export async function decideWithdrawal(id: string, actor: AuditActor, input: { action: 'approve' | 'reject' | 'mark_paid'; reason?: string; reference?: string }) {
  return withSystem('platform: decide referral withdrawal', async (trx) => {
    const w = await trx.selectFrom('referral_withdrawals').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
    if (!w) throw Errors.notFound('withdrawal');
    const now = new Date();
    const bad = () => Errors.conflict('invalid_transition', `Cannot ${input.action} a ${w.status} withdrawal`, { from: w.status });
    if (input.action === 'approve') {
      if (w.status !== 'requested') throw bad();
      await trx.updateTable('referral_withdrawals').set({ status: 'approved', decided_by: actor.userId, decided_at: now, version: w.version + 1 }).where('id', '=', id).execute();
    } else if (input.action === 'reject') {
      if (!['requested', 'approved'].includes(w.status)) throw bad();
      if (!input.reason) throw Errors.invalid('reason_required', 'A reason is required to reject');
      await trx.updateTable('referral_withdrawals').set({ status: 'rejected', reject_reason: input.reason, decided_by: actor.userId, decided_at: now, version: w.version + 1 }).where('id', '=', id).execute();
      await trx.insertInto('referral_ledger').values({ referrer_id: w.referrer_id, kind: 'withdrawal_release', amount_minor: w.amount_minor, withdrawal_id: w.id, note: input.reason, created_by: actor.userId }).execute();
    } else {
      if (w.status !== 'approved') throw bad();
      if (!input.reference) throw Errors.invalid('reference_required', 'Enter the transfer reference');
      await trx.updateTable('referral_withdrawals').set({ status: 'paid', paid_at: now, paid_reference: input.reference, version: w.version + 1 }).where('id', '=', id).execute();
    }
    await audit(trx, actor, `platform.referral.withdrawal_${input.action}`, { targetType: 'referral_withdrawal', targetId: id, data: { referrer_id: w.referrer_id, amount_minor: w.amount_minor, reason: input.reason ?? null, reference: input.reference ?? null } });
    return trx.selectFrom('referral_withdrawals').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
  });
}

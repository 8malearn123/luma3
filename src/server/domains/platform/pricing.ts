import { sql } from 'kysely';
import type { z } from 'zod';
import { withCentral, withSystem, type Tx } from '../../db/client';
import { Errors } from '../../http/errors';
import { audit, type AuditActor } from '../../infra/audit';
import { applyDiscounts, type PlatformSettings } from '@/shared/platform-settings';
import type { promotionCreateInput, promotionUpdateInput } from '@/shared/schemas/admin';
import { readPlatformSettings } from './settings';

/**
 * LUMA plan pricing: list prices (plans table, VAT-inclusive), founding-customer
 * seats (30% for the first 100 paying subscribers while the subscription stays
 * current) and time-limited promotions. Discounts stack in sequence: founding
 * first, then the promotion.
 */
export type BillingCycle = 'monthly' | 'yearly';
type PlanRow = { id: string; code: string; price_monthly_minor: number | null; price_yearly_minor: number | null; currency: string };
type PromoRow = { id: string; code: string | null; name_ar: string; name_en: string; discount_bp: number; plan_codes: string[]; billing_cycles: string[]; starts_at: Date; ends_at: Date; duration_cycles: number | null; max_redemptions: number | null; redemptions: number; status: string };

export function listPrice(plan: Pick<PlanRow, 'price_monthly_minor' | 'price_yearly_minor'>, cycle: BillingCycle) {
  return cycle === 'yearly' ? plan.price_yearly_minor : plan.price_monthly_minor;
}

export async function foundingSeats(trx: Tx, settings?: PlatformSettings) {
  const s = settings ?? await readPlatformSettings(trx);
  const r = await sql<{ n: number }>`select count(*)::int as n from subscriptions where founding_number is not null`.execute(trx);
  const taken = r.rows[0]?.n ?? 0;
  return { enabled: s.founding_enabled, total: s.founding_seats_total, taken, remaining: s.founding_enabled ? Math.max(0, s.founding_seats_total - taken) : 0, discount_bp: s.founding_discount_bp };
}

/**
 * Gives a subscription the next founding seat, once, when it becomes a paying
 * subscriber (first invoice or first activation). No-op if it already has one,
 * lost it, or no seats remain. Serialised by an advisory lock.
 */
export async function ensureFoundingSeat(trx: Tx, subId: string) {
  const sub = await trx.selectFrom('subscriptions').select(['id', 'founding_number', 'founding_lost_at', 'status']).where('id', '=', subId).executeTakeFirstOrThrow();
  if (sub.founding_number !== null || sub.founding_lost_at !== null || ['cancelled', 'expired'].includes(sub.status)) return null;
  await sql`select pg_advisory_xact_lock(hashtext('luma:founding_seats'))`.execute(trx);
  const seats = await foundingSeats(trx);
  if (!seats.enabled || seats.remaining <= 0) return null;
  const next = await sql<{ n: number }>`select coalesce(max(founding_number), 0)::int + 1 as n from subscriptions`.execute(trx);
  const n = next.rows[0]!.n;
  await trx.updateTable('subscriptions').set({ founding_number: n, founding_discount_bp: seats.discount_bp }).where('id', '=', subId).execute();
  return n;
}

function promoApplies(p: PromoRow, planCode: string, cycle: BillingCycle, now: Date) {
  return p.status === 'active' && p.starts_at <= now && p.ends_at > now
    && (p.plan_codes.length === 0 || p.plan_codes.includes(planCode))
    && (p.billing_cycles.length === 0 || p.billing_cycles.includes(cycle))
    && (p.max_redemptions === null || p.redemptions < p.max_redemptions);
}

/**
 * The promotion for a new subscription: the given code (must be valid, else
 * 422), otherwise the best running automatic offer, otherwise none.
 */
export async function resolvePromotion(trx: Tx, q: { code?: string | null; planCode: string; cycle: BillingCycle; now?: Date }) {
  const now = q.now ?? new Date();
  if (q.code) {
    const p = await trx.selectFrom('plan_promotions').selectAll().where(sql<string>`code::text`, 'ilike', q.code).executeTakeFirst() as PromoRow | undefined;
    if (!p || !promoApplies(p, q.planCode, q.cycle, now)) throw Errors.invalid('promotion_invalid', 'This offer code is not valid for the selected plan');
    return p;
  }
  const autos = await trx.selectFrom('plan_promotions').selectAll().where('code', 'is', null).where('status', '=', 'active')
    .where('starts_at', '<=', now).where('ends_at', '>', now).execute() as PromoRow[];
  return autos.filter((p) => promoApplies(p, q.planCode, q.cycle, now)).sort((a, b) => b.discount_bp - a.discount_bp)[0] ?? null;
}

/** Records a promotion on a subscription (redemption counted atomically). */
export async function attachPromotion(trx: Tx, subId: string, promo: PromoRow) {
  const r = await sql<{ id: string }>`
    update plan_promotions set redemptions = redemptions + 1
    where id = ${promo.id} and (max_redemptions is null or redemptions < max_redemptions) returning id`.execute(trx);
  if (!r.rows.length) throw Errors.conflict('promotion_exhausted', 'This offer is no longer available');
  await trx.updateTable('subscriptions').set({ promotion_id: promo.id, promotion_discount_bp: promo.discount_bp, promotion_cycles_remaining: promo.duration_cycles }).where('id', '=', subId).execute();
}

type SubForCharge = { id: string; billing_cycle: string; founding_number: number | null; founding_discount_bp: number | null; founding_lost_at: Date | null; promotion_id: string | null; promotion_discount_bp: number | null; promotion_cycles_remaining: number | null };

/** What a subscription pays for its next cycle (pure; no side effects). */
export function chargeFor(sub: SubForCharge, plan: Pick<PlanRow, 'price_monthly_minor' | 'price_yearly_minor'>) {
  const list = listPrice(plan, sub.billing_cycle as BillingCycle);
  if (list === null) return null;
  const founding = sub.founding_number !== null && sub.founding_lost_at === null ? sub.founding_discount_bp ?? 0 : 0;
  const promo = sub.promotion_id && sub.promotion_discount_bp && (sub.promotion_cycles_remaining === null || sub.promotion_cycles_remaining > 0) ? sub.promotion_discount_bp : 0;
  const amount = applyDiscounts(list, [founding, promo]);
  return {
    list_minor: list, amount_minor: amount, discount_minor: list - amount,
    detail: { founding_bp: founding, founding_number: founding ? sub.founding_number : null, promotion_bp: promo, promotion_id: promo ? sub.promotion_id : null },
  };
}

/** After an invoice uses a limited promotion, one cycle is consumed. */
export async function consumePromotionCycle(trx: Tx, sub: SubForCharge) {
  if (sub.promotion_id && sub.promotion_cycles_remaining !== null && sub.promotion_cycles_remaining > 0) {
    await trx.updateTable('subscriptions').set({ promotion_cycles_remaining: sub.promotion_cycles_remaining - 1 }).where('id', '=', sub.id).execute();
  }
}

// ── Public pricing (/pricing and GET /api/v1/pricing) ───────────────────────
export async function publicPricing(q: { promo?: string } = {}) {
  return withCentral(async (trx) => {
    const plans = await trx.selectFrom('plans').select(['id', 'code', 'name_ar', 'name_en', 'description_ar', 'description_en', 'price_monthly_minor', 'price_yearly_minor', 'price_is_test', 'currency', 'trial_days', 'sort'])
      .where('status', '=', 'active').orderBy('sort').execute();
    const features = await trx.selectFrom('plan_features').selectAll().execute();
    const settings = await readPlatformSettings(trx);
    // Founding seat count is cross-tenant aggregate data; read in system scope.
    const seats = await withSystem('public pricing: founding seats remaining', (s) => foundingSeats(s, settings));
    const now = new Date();
    const autos = await trx.selectFrom('plan_promotions').selectAll().where('code', 'is', null).where('status', '=', 'active')
      .where('starts_at', '<=', now).where('ends_at', '>', now).execute() as PromoRow[];
    let codePromo: PromoRow | null = null;
    let promoError: string | null = null;
    if (q.promo) {
      codePromo = await trx.selectFrom('plan_promotions').selectAll().where(sql<string>`code::text`, 'ilike', q.promo).executeTakeFirst() as PromoRow | undefined ?? null;
      if (!codePromo || codePromo.status !== 'active' || codePromo.starts_at > now || codePromo.ends_at <= now) { promoError = 'promotion_invalid'; codePromo = null; }
    }
    const foundingBp = seats.remaining > 0 ? seats.discount_bp : 0;
    return {
      currency: 'SAR', vat_inclusive: true, monthly_bookings_limit: null,
      founding: seats,
      promotion_code: q.promo ? { code: q.promo, valid: !!codePromo, error: promoError } : null,
      plans: plans.map((p) => {
        const cycles = (['monthly', 'yearly'] as const).map((cycle) => {
          const list = listPrice(p, cycle);
          const promo = codePromo && promoApplies(codePromo, p.code, cycle, now) ? codePromo
            : autos.filter((a) => promoApplies(a, p.code, cycle, now)).sort((a, b) => b.discount_bp - a.discount_bp)[0] ?? null;
          return {
            cycle, list_minor: list,
            founding_minor: list === null || !foundingBp ? null : applyDiscounts(list, [foundingBp]),
            promotion: promo ? { id: promo.id, name_ar: promo.name_ar, name_en: promo.name_en, discount_bp: promo.discount_bp, ends_at: promo.ends_at, code: promo.code, duration_cycles: promo.duration_cycles } : null,
            promo_minor: list === null || !promo ? null : applyDiscounts(list, [promo.discount_bp]),
          };
        });
        return {
          ...p, pricing_configured: p.price_monthly_minor !== null,
          yearly_saving_minor: p.price_monthly_minor !== null && p.price_yearly_minor !== null ? p.price_monthly_minor * 12 - p.price_yearly_minor : null,
          cycles,
          features: Object.fromEntries(features.filter((f) => f.plan_id === p.id).map((f) => [f.feature_key, { enabled: f.enabled, limit: f.limit_value }])),
        };
      }),
    };
  });
}

// ── Promotions (platform owner) ─────────────────────────────────────────────
export async function listPromotions() {
  return withCentral(async (trx) => {
    const rows = await trx.selectFrom('plan_promotions').selectAll().orderBy('created_at', 'desc').limit(200).execute();
    const now = new Date();
    return rows.map((p) => ({ ...p, code: p.code ?? null, running: p.status === 'active' && p.starts_at <= now && p.ends_at > now }));
  });
}

export async function createPromotion(actor: AuditActor, input: z.infer<typeof promotionCreateInput>) {
  return withCentral(async (trx) => {
    const p = await trx.insertInto('plan_promotions').values({
      code: input.code ?? null, name_ar: input.name_ar, name_en: input.name_en, discount_bp: input.discount_bp,
      plan_codes: input.plan_codes ?? [], billing_cycles: input.billing_cycles ?? [], starts_at: new Date(input.starts_at), ends_at: new Date(input.ends_at),
      duration_cycles: input.duration_cycles ?? null, max_redemptions: input.max_redemptions ?? null, created_by: actor.userId,
    }).returningAll().executeTakeFirstOrThrow();
    await audit(trx, actor, 'platform.promotion.created', { targetType: 'plan_promotion', targetId: p.id, data: { code: p.code, discount_bp: p.discount_bp, ends_at: p.ends_at.toISOString() } });
    return p;
  });
}

export async function updatePromotion(id: string, actor: AuditActor, input: z.infer<typeof promotionUpdateInput>) {
  return withCentral(async (trx) => {
    const cur = await trx.selectFrom('plan_promotions').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
    if (!cur) throw Errors.notFound('promotion');
    if (cur.version !== input.version) throw Errors.versionConflict(cur.version);
    const { version: _v, starts_at, ends_at, ...rest } = input;
    const p = await trx.updateTable('plan_promotions').set({
      ...rest, ...(starts_at ? { starts_at: new Date(starts_at) } : {}), ...(ends_at ? { ends_at: new Date(ends_at) } : {}), version: cur.version + 1,
    }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
    await audit(trx, actor, 'platform.promotion.updated', { targetType: 'plan_promotion', targetId: id, data: { fields: Object.keys(rest).concat(starts_at ? ['starts_at'] : [], ends_at ? ['ends_at'] : []) } });
    return p;
  });
}

/** Founding seats and the subscribers holding them (platform). */
export async function foundingOverview() {
  return withSystem('platform: founding seats', async (trx) => {
    const seats = await foundingSeats(trx);
    const holders = await trx.selectFrom('subscriptions as s').innerJoin('tenants as t', 't.id', 's.tenant_id').innerJoin('plans as p', 'p.id', 's.plan_id')
      .select(['s.id', 's.founding_number', 's.founding_discount_bp', 's.founding_lost_at', 's.status', 's.billing_cycle', sql<string>`t.slug::text`.as('tenant_slug'), 't.name as tenant_name', 'p.code as plan_code'])
      .where('s.founding_number', 'is not', null).orderBy('s.founding_number').limit(1000).execute();
    return { ...seats, holders };
  });
}

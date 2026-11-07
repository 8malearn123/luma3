import { withSystem, withTenant } from '../../db/client';
import type { SessionUser } from '../../auth/service';

type Tier = { code: string; name_ar: string; name_en: string; min_lifetime_points: number };

/** Current tier = highest tier whose threshold her lifetime points reached; next = the following one. */
export function tierFor(tiers: Tier[], lifetime: number) {
  const asc = [...tiers].sort((a, b) => a.min_lifetime_points - b.min_lifetime_points);
  const current = [...asc].reverse().find((t) => lifetime >= t.min_lifetime_points) ?? null;
  const next = asc.find((t) => t.min_lifetime_points > lifetime) ?? null;
  return { current, next, points_to_next: next ? next.min_lifetime_points - lifetime : null };
}

/**
 * Loyalty in /account: for every business she deals with that runs a loyalty
 * programme (or where she still holds points), her balance, tier, progress to
 * the next tier, when inactive points would expire, and the rewards she can
 * redeem there. Read per business inside that business's tenant scope.
 */
export async function myLoyalty(user: SessionUser) {
  const rels = await withSystem('customer reads her own business relationships for loyalty', (trx) => trx.selectFrom('tenant_customers as c').innerJoin('tenants as t', 't.id', 'c.tenant_id')
    .select(['c.id as tenant_customer_id', 'c.tenant_id', 't.name as tenant_name', 't.slug as tenant_slug'])
    .where('c.user_id', '=', user.userId).where('c.status', '=', 'active').where('t.status', '=', 'active')
    .orderBy('t.name').execute());
  const out = [];
  for (const r of rels) {
    const row = await withTenant(r.tenant_id, async (trx) => {
      const prog = await trx.selectFrom('loyalty_programs').select(['is_enabled', 'tiers', 'points_expiry_days', 'points_per_currency_unit']).where('tenant_id', '=', r.tenant_id).executeTakeFirst();
      const acct = await trx.selectFrom('loyalty_accounts').select(['balance', 'lifetime_earned', 'last_activity_at']).where('tenant_customer_id', '=', r.tenant_customer_id).executeTakeFirst();
      if (!prog?.is_enabled && !(acct && acct.balance > 0)) return null;
      const rewards = prog?.is_enabled ? await trx.selectFrom('rewards').select(['id', 'name_ar', 'name_en', 'points_cost', 'kind', 'value']).where('is_active', '=', true).orderBy('points_cost').limit(20).execute() : [];
      const lifetime = acct?.lifetime_earned ?? 0;
      const balance = acct?.balance ?? 0;
      const tier = tierFor((prog?.tiers as Tier[] | null) ?? [], lifetime);
      return {
        tenant_id: r.tenant_id, tenant_name: r.tenant_name, tenant_slug: String(r.tenant_slug), enabled: !!prog?.is_enabled,
        balance, lifetime_earned: lifetime, tier: tier.current, next_tier: tier.next, points_to_next: tier.points_to_next,
        points_per_sar: Number(prog?.points_per_currency_unit ?? 0),
        expires_at: acct && balance > 0 && prog?.points_expiry_days ? new Date(acct.last_activity_at.getTime() + prog.points_expiry_days * 86_400_000).toISOString() : null,
        rewards: rewards.map((x) => ({ ...x, redeemable: balance >= x.points_cost })),
      };
    });
    if (row) out.push(row);
  }
  return out;
}

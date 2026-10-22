import { sql } from 'kysely';
import type { z } from 'zod';
import { withSystem } from '../../db/client';
import { Errors } from '../../http/errors';
import { audit, type AuditActor } from '../../infra/audit';
import { PLAN_FEATURES } from '@/shared/plans';
import type { planUpdateInput } from '@/shared/schemas/platform';

/**
 * Plans Sanaa / Wahaj / Fareed and their feature matrix. Prices are NULL
 * ("pricing not configured") until the LUMA owner enters them; any entered
 * price stays labelled as a TEST price while price_is_test is true.
 */
export async function listPlans() {
  return withSystem('platform: plans', async (trx) => {
    const plans = await trx.selectFrom('plans').selectAll().orderBy('sort').execute();
    const features = await trx.selectFrom('plan_features').selectAll().execute();
    const subs = await trx.selectFrom('subscriptions').select(['plan_id', 'status', sql<number>`count(*)::int`.as('n')]).groupBy(['plan_id', 'status']).execute();
    const keys = Object.keys(PLAN_FEATURES);
    return plans.map((p) => ({
      ...p,
      pricing_configured: p.price_monthly_minor !== null,
      features: keys.map((k) => {
        const f = features.find((x) => x.plan_id === p.id && x.feature_key === k);
        return { feature_key: k, kind: PLAN_FEATURES[k as keyof typeof PLAN_FEATURES].kind, enabled: f?.enabled ?? false, limit_value: f?.limit_value ?? null, configured: !!f };
      }),
      subscriptions: Object.fromEntries(subs.filter((s) => s.plan_id === p.id).map((s) => [s.status, s.n])),
    }));
  });
}

export async function updatePlan(id: string, actor: AuditActor, input: z.infer<typeof planUpdateInput>) {
  await withSystem('platform: edit plan', async (trx) => {
    const cur = await trx.selectFrom('plans').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
    if (!cur) throw Errors.notFound('plan');
    if (cur.version !== input.version) throw Errors.versionConflict(cur.version);
    const { version: _v, features, ...fields } = input;
    if (fields.status && fields.status !== 'active' && cur.status === 'active') {
      const active = await trx.selectFrom('plans').select(sql<number>`count(*)::int`.as('n')).where('status', '=', 'active').where('id', '<>', id).executeTakeFirstOrThrow();
      if (active.n === 0) throw Errors.conflict('last_active_plan', 'At least one plan must stay active');
    }
    // Entering a price never silently makes it "final": it stays a test price unless explicitly changed.
    await trx.updateTable('plans').set({ ...fields, version: cur.version + 1, updated_by: actor.userId }).where('id', '=', id).execute();
    if (features?.length) {
      for (const f of features) {
        const meta = PLAN_FEATURES[f.feature_key];
        const limit = meta.kind === 'limit' ? f.limit_value : null;
        await trx.insertInto('plan_features').values({ plan_id: id, feature_key: f.feature_key, enabled: f.enabled, limit_value: limit })
          .onConflict((oc) => oc.columns(['plan_id', 'feature_key']).doUpdateSet({ enabled: f.enabled, limit_value: limit })).execute();
      }
    }
    await audit(trx, actor, 'platform.plan.updated', { targetType: 'plan', targetId: id, data: { code: cur.code, fields: Object.keys(fields), features: features?.map((f) => f.feature_key) ?? [] } });
  });
  return (await listPlans()).find((p) => p.id === id);
}

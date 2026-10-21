import { withSystem } from '../../db/client';
import { audit } from '../../infra/audit';
import { notifyCapability, notifyUsers } from '../../infra/notify';
import { registerPeriodic } from '../../jobs/registry';

/**
 * Restrictions do not live forever:
 *  - decisions past expires_at become `expired` (payment terms already ignore
 *    them by time; this makes the status explicit and audited);
 *  - decisions past review_at are flagged once and their reviewers notified
 *    (tenant: members with incidents.review; platform: policy reviewers).
 */
export async function runPolicySweep(now = new Date()) {
  return withSystem('policy sweep: expire decisions and flag reviews', async (trx) => {
    const expired = await trx.updateTable('policy_decisions')
      .set({ status: 'expired', ended_at: now, end_reason: 'expires_at reached' })
      .where('status', '=', 'active').where('expires_at', 'is not', null).where('expires_at', '<=', now)
      .returning(['id', 'tenant_id', 'scope', 'action']).execute();
    for (const d of expired) {
      await audit(trx, { userId: null, kind: 'system' }, 'policy_decision.expired', { tenantId: d.tenant_id, targetType: 'policy_decision', targetId: d.id, data: { action: d.action, by: 'sweep' } });
    }

    const due = await trx.updateTable('policy_decisions')
      .set({ review_flagged_at: now })
      .where('status', '=', 'active').where('review_at', 'is not', null).where('review_at', '<=', now).where('review_flagged_at', 'is', null)
      .returning(['id', 'tenant_id', 'scope', 'action']).execute();
    let platformReviewers: string[] | null = null;
    for (const d of due) {
      await audit(trx, { userId: null, kind: 'system' }, 'policy_decision.review_due', { tenantId: d.tenant_id, targetType: 'policy_decision', targetId: d.id });
      const n = {
        kind: 'policy.review_due', title_ar: 'قرار سياسة يحتاج إلى مراجعة', title_en: 'A policy decision is due for review',
        dedupe_key: `policy.review_due:${d.id}`,
      };
      if (d.scope === 'tenant' && d.tenant_id) {
        const t = await trx.selectFrom('tenants').select('slug').where('id', '=', d.tenant_id).executeTakeFirst();
        await notifyCapability(trx, d.tenant_id, ['incidents.review'], { ...n, target_path: t ? `/app/${t.slug}/policies?decision=${d.id}` : undefined });
      } else {
        platformReviewers ??= (await trx.selectFrom('platform_roles').select('user_id').where('role', 'in', ['policy_reviewer', 'platform_owner']).where('revoked_at', 'is', null).execute()).map((r) => r.user_id);
        await notifyUsers(trx, null, platformReviewers, { ...n, target_path: '/platform/policies' });
      }
    }
    return { expired: expired.length, flagged: due.length };
  });
}

registerPeriodic({ name: 'policy-decisions-sweep', everySec: 300, run: async () => { await runPolicySweep(); } });

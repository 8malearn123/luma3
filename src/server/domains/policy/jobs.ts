import { withSystem } from '../../db/client';
import { audit } from '../../infra/audit';
import { notifyCapability, notifyUsers } from '../../infra/notify';
import { registerPeriodic } from '../../jobs/registry';
import { storage } from '../../infra/storage';

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

/**
 * Evidence retention: files past `retain_until` are deleted from storage and the
 * asset marked `deleted` (the media route then returns 404). Evidence is kept
 * while the incident has an open appeal or backs an active decision.
 */
export async function runEvidencePurge(now = new Date()) {
  const due = await withSystem('evidence retention: find expired files', (trx) => trx.selectFrom('incident_evidence as e')
    .innerJoin('assets as a', (j) => j.onRef('a.id', '=', 'e.asset_id').onRef('a.tenant_id', '=', 'e.tenant_id'))
    .select(['e.id', 'e.tenant_id', 'e.incident_id', 'a.id as asset_id', 'a.storage_key'])
    .where('e.retain_until', '<=', now).where('a.status', '!=', 'deleted')
    .where(({ not, exists, selectFrom }) => not(exists(selectFrom('appeals as ap').select('ap.id')
      .whereRef('ap.incident_id', '=', 'e.incident_id').where('ap.status', 'in', ['submitted', 'under_review']))))
    .where(({ not, exists, selectFrom }) => not(exists(selectFrom('policy_decisions as d').select('d.id')
      .whereRef('d.source_incident_id', '=', 'e.incident_id').where('d.status', '=', 'active'))))
    .limit(500).execute());
  let purged = 0;
  for (const r of due) {
    await storage().delete(r.storage_key);
    await withSystem('evidence retention: mark deleted', async (trx) => {
      await trx.updateTable('assets').set({ status: 'deleted' }).where('id', '=', r.asset_id).execute();
      await audit(trx, { userId: null, kind: 'system' }, 'incident_evidence.purged', { tenantId: r.tenant_id, targetType: 'incident', targetId: r.incident_id, data: { evidence_id: r.id, reason: 'retention_period_ended' } });
    });
    purged++;
  }
  return { purged };
}

registerPeriodic({ name: 'policy-evidence-retention', everySec: 6 * 3600, run: async () => { await runEvidencePurge(); } });
registerPeriodic({ name: 'policy-decisions-sweep', everySec: 300, run: async () => { await runPolicySweep(); } });

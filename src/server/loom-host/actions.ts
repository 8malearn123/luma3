import type { ActionCommand, ActionPort, ActionResult } from '@/loom';
import { withTenant } from '../db/client';
import { Errors } from '../http/errors';
import type { AuditActor } from '../infra/audit';
import { featureEnabled, hasCapability, type TenantAccess } from '../tenancy/access';
import { localToday, monthBounds } from '../domains/analytics/period';
import { createCampaign } from '../domains/marketing/campaigns';
import { appendVersion, saveGeneratedPlan } from '../domains/marketing/plans';
import { createSegment } from '../domains/marketing/segments';
import { proposePrice } from '../domains/catalog/service';
import type { PlanContent, SegmentCondition } from '@/shared/schemas/marketing';

/**
 * LUMA's ActionPort for Loom (§4.1 rule 3). Every write goes through the
 * existing marketing / catalog domain functions and their rules: plan
 * versions are appended (an approved version never changes), campaigns are
 * drafts that still need campaigns.approve, prices are proposals that still
 * need the owner's approval in the catalog.
 */
export function lumaActionPort(access: TenantAccess, actor: AuditActor, locale: 'ar' | 'en'): ActionPort {
  const pick = (t: { ar: string; en: string }) => (locale === 'ar' ? t.ar || t.en : t.en || t.ar);
  return {
    async execute(_businessId: string, cmd: ActionCommand): Promise<ActionResult> {
      switch (cmd.kind) {
        case 'plan_action': return addPlanAction(access, actor, cmd, pick);
        case 'campaign_draft': {
          if (!featureEnabled(access, 'feature.campaigns')) throw Errors.forbidden('Campaigns are not included in your plan', { reason: 'plan_feature' });
          const conditions = mapSegment(cmd.segment, cmd.channel);
          return withTenant(access.tenantId, async (trx) => {
            const seg = conditions.length ? await createSegment(access, actor, { name: pick(cmd.name).slice(0, 120), definition: { conditions } }, trx) : null;
            const c = await createCampaign(access, actor, {
              name: pick(cmd.name).slice(0, 120), channel: cmd.channel, segment_id: seg?.id ?? null, content: { body: pick(cmd.body).slice(0, 1500) },
              holdout_bp: 1000, attribution_window_days: 14, frequency_cap_days: 7, quiet_hours: { from: '21:00', to: '09:00' },
            }, trx);
            return { target: 'campaign_draft' as const, ref_id: c.id, status: c.status };
          });
        }
        case 'price_proposal': {
          if (!hasCapability(access, 'catalog.edit')) throw Errors.forbidden('Price proposals need catalog.edit');
          const p = await proposePrice(access, actor, cmd.offering_id, { proposed_price_minor: cmd.proposed_price_minor, reason: cmd.reason }, 'recommendation');
          return { target: 'price_proposal', ref_id: p.id, status: p.status };
        }
        default: throw Errors.invalid('unknown_action');
      }
    },
  };
}

function mapSegment(def: Record<string, unknown> | null, channel: string): SegmentCondition[] {
  const conds = ((def?.conditions ?? []) as Array<Record<string, unknown>>);
  const out: SegmentCondition[] = [];
  for (const c of conds) {
    if (c.type === 'due_for_offering') out.push({ type: 'due_for_service', service_id: String(c.offering_id) });
    else if (c.type === 'visited_offering') out.push({ type: 'visited_service', service_id: String(c.offering_id) });
    else if (c.type === 'not_visited_offering') out.push({ type: 'not_visited_service', service_id: String(c.offering_id) });
    else if (c.type === 'last_visit_before_days') out.push({ type: 'last_visit_before_days', days: Number(c.days) });
    else if (c.type === 'has_consent') out.push({ type: 'has_consent', channel: channel as 'in_app' });
  }
  return out.slice(0, 10);
}

async function addPlanAction(access: TenantAccess, actor: AuditActor, cmd: Extract<ActionCommand, { kind: 'plan_action' }>, pick: (t: { ar: string; en: string }) => string): Promise<ActionResult> {
  const month = monthBounds(localToday(access.timezone));
  return withTenant(access.tenantId, async (trx) => {
    const plan = await trx.selectFrom('marketing_plans as p').leftJoin('plan_versions as v', 'v.id', 'p.current_version_id').select(['p.id', 'v.content'])
      .where('p.tenant_id', '=', access.tenantId).where('p.kind', '=', 'monthly').where('p.period_start', '=', month.from).where('p.is_example', '=', false)
      .where('p.status', 'not in', ['rejected', 'completed']).orderBy('p.created_at', 'desc').executeTakeFirst();
    const n = Date.now().toString(36).slice(-6);
    const initiative = { id: `loom_${n}`, title: pick(cmd.title).slice(0, 200), description: pick(cmd.description).slice(0, 1500), evidence_refs: cmd.evidence_refs.slice(0, 20) };
    const activity = {
      id: `la_${n}`, title: pick(cmd.title).slice(0, 200), initiative_id: initiative.id, date_from: cmd.window.from, date_to: cmd.window.to, channel: cmd.channel,
      content_idea: null, owner: null, capacity_note: null, monthly_goal_ref: null, status: 'planned' as const,
    };
    if (plan?.content) {
      const content = plan.content as PlanContent;
      const next: PlanContent = { ...content, initiatives: [...content.initiatives, initiative].slice(-20), activities: [...content.activities, activity].slice(-60) };
      const v = await appendVersion(trx, access.tenantId, plan.id, { content: next, source: 'manual', createdBy: actor.userId, changeNote: `loom:${cmd.opportunity_id}` });
      return { target: 'plan_action' as const, ref_id: plan.id, status: `version_${v.version}` };
    }
    const content: PlanContent = {
      goal: pick(cmd.title).slice(0, 500), baseline: [], initiatives: [initiative], activities: [activity], dates: { start: month.from, end: month.to }, owner: '',
      budget: { amount_minor: null, status: 'unknown', assumptions: '' }, metrics: [], monthly_goals: [], experimental: false, limitations: '',
    };
    const r = await saveGeneratedPlan(trx, access.tenantId, { kind: 'monthly', from: month.from, to: month.to, title: pick(cmd.title).slice(0, 200), content, source: 'manual', createdBy: actor.userId });
    return { target: 'plan_action' as const, ref_id: r.plan_id, status: `version_${r.version}` };
  });
}

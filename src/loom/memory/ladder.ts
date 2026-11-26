import type { Tx } from '../db';
import { NON_IDEA_REASONS, type CardContent, type DecisionReason } from '../contracts/opportunity';
import { writeFact } from '../profile/facts';

/**
 * Decision ladder (§10.1): every stage is a separate append-only row in
 * loom.decision_history — viewed (usage only, not a quality signal), reacted
 * (taste, never an outcome), decided (with a categorised reason for defer and
 * dismiss), scheduled (converted into a plan action / campaign / price
 * proposal), executed, completed (window closed) and measured.
 */
export const LADDER_STAGES = ['viewed', 'reacted', 'decided', 'scheduled', 'executed', 'completed', 'measured'] as const;
export type LadderStage = (typeof LADDER_STAGES)[number];
export const REACTIONS = ['like', 'dislike', 'none'] as const;
export type Reaction = (typeof REACTIONS)[number];

export type LadderEvent = {
  opportunity_id?: string | null; initiative_id?: string | null; stage: LadderStage; action?: string | null; reason?: DecisionReason | null;
  note?: string | null; counts_as_idea_failure?: boolean | null; data?: Record<string, unknown>; actor?: string | null;
};

export async function recordLadder(trx: Tx, businessId: string, e: LadderEvent) {
  await trx.insertInto('loom.decision_history').values({
    business_id: businessId, opportunity_id: e.opportunity_id ?? null, initiative_id: e.initiative_id ?? null, stage: e.stage, action: e.action ?? null,
    reason: e.reason ?? null, note: e.note ?? null, counts_as_idea_failure: e.counts_as_idea_failure ?? null, data: JSON.stringify(e.data ?? {}), actor_id: e.actor ?? null,
  }).execute();
}

/** Capacity, inventory, budget and timing rejections are not a verdict on the marketing idea (T13). */
export const countsAsIdeaFailure = (action: string, reason: DecisionReason | null) => (action === 'dismiss' && reason ? !NON_IDEA_REASONS.includes(reason) : null);

/** `viewed` is recorded at most once per person and opportunity every 12 hours. */
export async function recordView(trx: Tx, businessId: string, opportunityId: string, actor: string | null) {
  const recent = await trx.selectFrom('loom.decision_history').select('id').where('business_id', '=', businessId).where('opportunity_id', '=', opportunityId)
    .where('stage', '=', 'viewed').where('actor_id', actor ? '=' : 'is', actor).where('created_at', '>', new Date(Date.now() - 12 * 3_600_000)).executeTakeFirst();
  if (recent) return false;
  await recordLadder(trx, businessId, { opportunity_id: opportunityId, stage: 'viewed', actor });
  return true;
}

/** Like / dislike: stored in loom.feedback (separately from outcomes) and as a `reacted` ladder row. */
export async function recordReaction(trx: Tx, businessId: string, opportunityId: string, actor: string | null, reaction: Reaction) {
  await trx.insertInto('loom.feedback').values({ business_id: businessId, opportunity_id: opportunityId, reaction, actor_id: actor }).execute();
  await recordLadder(trx, businessId, { opportunity_id: opportunityId, stage: 'reacted', action: reaction, actor });
}

export async function currentReaction(trx: Tx, businessId: string, opportunityId: string, actor: string | null): Promise<Reaction> {
  if (!actor) return 'none';
  const r = await trx.selectFrom('loom.feedback').select('reaction').where('business_id', '=', businessId).where('opportunity_id', '=', opportunityId)
    .where('actor_id', '=', actor).orderBy('created_at', 'desc').limit(1).executeTakeFirst();
  return (r?.reaction as Reaction | undefined) ?? 'none';
}

export const brandFitKey = (interventionId: string) => `brand.avoid_intervention:${interventionId}`;

/**
 * A `brand_fit` rejection infers "this kind of intervention does not suit the
 * brand". It is an INFERRED fact flagged needs_review: it changes nothing
 * until the owner confirms it (an explicit fact with the same key = true).
 */
export async function inferBrandFit(trx: Tx, businessId: string, opportunityId: string, card: CardContent, actor: string | null) {
  const key = brandFitKey(card.recommended_action.intervention_id);
  await writeFact(trx, businessId, {
    key, value: { intervention_id: card.recommended_action.intervention_id, kind: card.recommended_action.kind, category: card.category, opportunity_id: opportunityId },
    kind: 'inferred', source_type: 'user', source_ref: `decision:${opportunityId}`, confidence: 'medium', by: actor,
  });
  await trx.updateTable('loom.business_profile_facts').set({ needs_review: true }).where('business_id', '=', businessId).where('key', '=', key)
    .where('kind', '=', 'inferred').where('superseded_by', 'is', null).execute();
  return key;
}

export async function ladderFor(trx: Tx, businessId: string, ref: { opportunity_id?: string; initiative_id?: string }) {
  let q = trx.selectFrom('loom.decision_history').select(['id', 'opportunity_id', 'initiative_id', 'stage', 'action', 'reason', 'note', 'counts_as_idea_failure', 'data', 'actor_id', 'created_at'])
    .where('business_id', '=', businessId);
  if (ref.opportunity_id && ref.initiative_id) q = q.where((eb) => eb.or([eb('opportunity_id', '=', ref.opportunity_id!), eb('initiative_id', '=', ref.initiative_id!)]));
  else if (ref.opportunity_id) q = q.where('opportunity_id', '=', ref.opportunity_id);
  else if (ref.initiative_id) q = q.where('initiative_id', '=', ref.initiative_id);
  return q.orderBy('created_at').orderBy('id').execute();
}

import type { Localized } from '../util/text';

/**
 * ActionPort (§4.1 rule 3, §5.3): the HOST owns every write outside schema
 * loom. Loom hands the host a command; the host runs it through its own
 * permissions and approval flow (in LUMA: marketing plans, campaign drafts,
 * catalog price proposals) and returns a reference. Implemented for LUMA in
 * src/server/loom-host/actions.ts — never inside src/loom.
 */
export type ActionCommand =
  | { kind: 'plan_action'; opportunity_id: string; title: Localized; description: Localized; channel: string | null; window: { from: string; to: string }; evidence_refs: string[] }
  | { kind: 'campaign_draft'; opportunity_id: string; name: Localized; body: Localized; channel: 'in_app' | 'email' | 'sms' | 'whatsapp'; segment: Record<string, unknown> | null }
  | { kind: 'price_proposal'; opportunity_id: string; offering_id: string; proposed_price_minor: number; reason: string };

export type ActionResult = { target: ActionCommand['kind']; ref_id: string; status: string };

export interface ActionPort {
  execute(businessId: string, command: ActionCommand): Promise<ActionResult>;
}

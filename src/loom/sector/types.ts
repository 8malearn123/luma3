import type { ActionKind, Channel } from '../contracts/opportunity';
import type { ResourceKind } from '../contracts/canonical';
import type { Localized } from '../util/text';

export type InterventionId =
  | 'targeted_reminder' | 'off_peak_package' | 'value_add' | 'content_feature' | 'limited_discount'
  | 'reminder_due' | 'loyalty_reward' | 'open_slots' | 'waitlist_flow' | 'staff_cross_training' | 'price_review'
  | 'improve_description' | 'simplify_booking' | 'add_images' | 'faq' | 'bundle_with_top_service' | 'gift_with_service'
  | 'bundle_with_service' | 'in_store_recommendation' | 'cost_review' | 'record_costs' | 'loyalty_program'
  | 'add_shift' | 'restock' | 'review_results';

export type InterventionDef = {
  id: InterventionId;
  kind: ActionKind;
  /** Discount interventions are removed entirely under no_discounts and always ranked last. */
  discount?: boolean;
  /** Estimated owner effort (hours) and whether it has a cash cost (for the cost/effort factor). */
  effort_hours: number;
  cash_cost: 'none' | 'variable';
  channels: Channel[];
  description: Localized;
};

/** §16 sector pack (v1 subset used by phases 1–2). */
export type SectorPack = {
  id: string;
  version: string;
  vocabulary: Record<string, Localized>;
  capacityModel: { resources: ResourceKind[]; unit: 'minutes' | 'covers' | 'orders' | 'hours'; quiet_below: number; full_above: number };
  detectors: Array<{ id: string; params: Record<string, number> }>;
  interventions: Record<string, InterventionId[]>;
  catalog: Record<InterventionId, InterventionDef>;
  validation: { forbiddenClaims: RegExp[]; awarenessOnlyTopics: string[] };
  /** Default discount tried by a limited-discount intervention (bounded by the business maximum). */
  default_discount_bp: number;
};

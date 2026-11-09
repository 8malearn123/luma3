import type { Localized } from '../util/text';

/**
 * Canonical model (docs/LOOM_MARKETING_ARCHITECTURE.md §5.1). Every connector
 * maps its source into these records; nothing downstream of the connector
 * knows which system the data came from. Instants are epoch milliseconds,
 * calendar dates are 'YYYY-MM-DD' in the business timezone, money is integer
 * minor units of the business currency. Customers are pseudonymous.
 */

export const CANONICAL_ENTITIES = [
  'business', 'locations', 'offerings', 'offering_requirements', 'inventory_items', 'resources', 'capacity_windows',
  'transactions', 'cost_facts', 'demand_signals', 'reviews', 'complaints', 'customers', 'campaigns', 'calendar_events',
  'market_signals', 'host_preferences',
] as const;
export type CanonicalEntity = (typeof CANONICAL_ENTITIES)[number];

export type CanonicalBusiness = {
  id: string; sector: string; subsector: string | null; city: string | null; timezone: string; currency: string;
  locale: 'ar' | 'en'; created_at: number;
};

export type Location = { id: string; name: string; city: string | null; timezone: string; active: boolean };

export type OfferingKind = 'service' | 'product' | 'package' | 'membership' | 'gift';
export type Offering = {
  id: string; kind: OfferingKind; source_kind: string; name: Localized; price_minor: number;
  status: 'active' | 'inactive' | 'archived'; category_id: string | null;
  duration_min: number | null; buffer_min: number; has_image: boolean; has_description: boolean;
  /** The owner's recorded direct cost per unit (null = not recorded). */
  recorded_cost_minor: number | null;
  visible: boolean; product_id: string | null; location_id: string | null;
};

export type RequirementType = 'material' | 'resource' | 'skill' | 'time' | 'component';
export type OfferingRequirement = {
  offering_id: string; type: RequirementType;
  /** material → inventory item; skill → resource (qualified staff); resource → resource type; component → offering. */
  ref_id: string | null; quantity: number; unit: string;
  confidence: 'recipe' | 'estimated' | 'unknown';
};

export type InventoryUsage = 'sellable' | 'consumable' | 'both';
export type InventoryItem = {
  id: string; name: string; usage: InventoryUsage; on_hand: number; reserved: number; unit: string;
  unit_cost_minor: number | null; reorder_level: number | null; offering_id: string | null; location_id: string | null; active: boolean;
  /** Aggregates over the last 90 days (positive quantities). */
  consumed_90d: number; sold_90d: number;
};

export type ResourceKind = 'staff' | 'room' | 'equipment' | 'table' | 'vehicle' | 'generic';
export type Resource = { id: string; kind: ResourceKind; type_ref: string | null; location_id: string | null; active: boolean; skills: string[] };

export type CapacityState = 'free' | 'booked' | 'blocked' | 'leave';
export type CapacityWindow = { resource_id: string; start: number; end: number; state: CapacityState };

/** §5.2 normalised transaction status. Only 'fulfilled' counts as a sale. */
export const TRANSACTION_STATUSES = ['requested', 'confirmed', 'fulfilled', 'cancelled_customer', 'cancelled_business', 'no_show', 'expired'] as const;
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];

export type TransactionLine = {
  id: string; offering_id: string; resource_ids: string[]; qty: number;
  /** Line share of the transaction's net revenue (revenue_basis of the source). */
  net_minor: number; line_total_minor: number;
  /** Direct cost carried by the source line itself (e.g. product unit cost at sale), if any. */
  cost_direct_minor: number | null;
  starts_at: number; duration_min: number | null;
};

export type Transaction = {
  id: string; kind: 'booking' | 'order' | 'membership' | 'gift'; status: TransactionStatus; source_status: string;
  channel: string; origin: string | null; customer_ref: string;
  gross_minor: number; discount_minor: number; tax_minor: number; total_minor: number; refunded_minor: number;
  /** Net after discount, before tax, after refunds (source_mappings.revenue_basis). */
  net_minor: number;
  occurred_at: number; campaign_id: string | null; has_coupon: boolean;
  platform_fee_minor: number;
  lines: TransactionLine[];
  /** False when lines do not add up to the total or status contradicts amounts (§5.4 consistency). */
  consistent: boolean;
};

export type CostType = 'material' | 'commission' | 'payment_fee' | 'platform_fee' | 'labor' | 'overhead';
export type CostFact = {
  type: CostType;
  scope: { kind: 'offering'; offering_id: string } | { kind: 'category'; category: 'services' | 'products' } | { kind: 'business' };
  /** Per unit amount (minor) when fixed; null when the cost is a rate or unknown. */
  amount_minor: number | null;
  rate_bp: number | null;
  basis: 'recorded_cost' | 'recipe' | 'policy' | 'ledger' | 'not_tracked';
  completeness: 'complete' | 'partial' | 'missing';
  note?: Localized;
};

export type DemandSignalType = 'view' | 'booking_start' | 'no_availability' | 'waitlist' | 'waitlist_entry' | 'inquiry' | 'confirmed' | 'page_view';
export type DemandSignal = { type: DemandSignalType; offering_id: string | null; day: number; count: number; sessions: number };

export type Review = { id: string; rating: number; offering_id: string | null; resource_id: string | null; verified: boolean; at: number };
export type Complaint = { id: string; verified: boolean; offering_id: string | null; at: number };

export type Customer = {
  pseudo_id: string; created_at: number; first_seen: number | null; last_seen: number | null; visits: number;
  segments: string[]; acquisition_source: string | null; consents: Record<string, boolean>; dup_key: string | null;
};

export type Campaign = {
  id: string; channel: string; status: string; holdout_bp: number; started_at: number | null; finished_at: number | null;
  targeted: number; holdout: number; conversions: number; attributed_net_minor: number; cost_minor: number | null;
};

export type CalendarEvent = { id: string; title: string; kind: string; starts_on: string; ends_on: string; verified: boolean; has_source: boolean };
export type MarketSignal = { id: string; title: string; topic: string | null; published_at: number | null; observed_at: number; evidence_strength: string; freshness: 'fresh' | 'aging' | 'stale' | 'unknown' };

/** Preferences the host system already holds (e.g. LUMA marketing_preferences); profile facts of kind 'computed'. */
export type HostPreferences = { max_discount_bp: number | null; monthly_budget_minor: number | null; goals: string[]; tone: string | null; channels: string[] } | null;

export type DatasetMeta = {
  connection_id: string; connector: string; as_of: number; today: string;
  /** Analysis windows (business-local dates). */
  lookback_from: string; horizon_to: string; past_capacity_from: string;
  data_version: string; entity_versions: Record<string, string>; counts: Record<string, number>;
  /** Sync instant per entity (freshness check, §5.4). */
  synced_at: Record<string, number>;
  revenue_basis: string;
};

/** Everything one analysis reads. Built per analysis, never mutated afterwards. */
export type CanonicalDataset = {
  business: CanonicalBusiness;
  locations: Location[];
  offerings: Offering[];
  requirements: OfferingRequirement[];
  inventory: InventoryItem[];
  resources: Resource[];
  capacity: CapacityWindow[];
  transactions: Transaction[];
  costs: CostFact[];
  demand: DemandSignal[];
  reviews: Review[];
  complaints: Complaint[];
  customers: Customer[];
  campaigns: Campaign[];
  calendar: CalendarEvent[];
  signals: MarketSignal[];
  host_preferences: HostPreferences;
  meta: DatasetMeta;
};

export const isSale = (t: Pick<Transaction, 'status'>) => t.status === 'fulfilled';

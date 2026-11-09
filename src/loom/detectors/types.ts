import type { CanonicalDataset } from '../contracts/canonical';
import type { Channel, OpportunityCategory, SegmentDefinition } from '../contracts/opportunity';
import type { MetricContext } from '../metrics/context';
import type { MetricSet, QualityDomain } from '../metrics/registry';
import type { GoalKind, ResolvedProfile } from '../profile/facts';
import type { QualityReport } from '../quality/gate';
import type { SectorPack } from '../sector/types';
import type { Localized } from '../util/text';

/** Detector contract (§6.4): deterministic, no AI, no I/O. */
export type DetectContext = {
  ds: CanonicalDataset;
  ctx: MetricContext;
  metrics: MetricSet;
  quality: QualityReport;
  profile: ResolvedProfile;
  pack: SectorPack;
  params: Record<string, number>;
};

export type EvidenceItem = { metric_key: string; grain_ref: string; value: number | null; n: number; label: Localized; grade: 'observed' | 'inferred' | 'assumption' };

export type OpportunityCandidate = {
  detector_id: string;
  category: OpportunityCategory;
  /** Stable subject of the fingerprint (offering ids, slots, segment…). */
  subject_key: string;
  subject: { offering_ids: string[]; slots?: string[]; item_ids?: string[]; campaign_id?: string };
  title: Localized;
  why_now: Localized;
  evidence: EvidenceItem[];
  hypotheses: Localized[];
  /** Extra units (services/sales) the intervention aims for in the window; null when not volume-based. */
  target_volume: number | null;
  baseline_volume: number | null;
  /** Offering the capacity / inventory / margin checks run on (null: not offering-specific). */
  check_offering_id: string | null;
  window: { from: string; to: string };
  goal_kinds: GoalKind[];
  channels: Channel[];
  segment: { definition: SegmentDefinition | Record<string, unknown>; size: number | null; size_status: 'counted' | 'insufficient' | 'unknown' };
  success_metrics: Array<{ metric_key: string; baseline: number | null; target: number | null }>;
  measurement_design: 'holdout' | 'ab' | 'pre_post_with_control' | 'observational';
  limitations: Localized[];
  assumptions: Localized[];
  prerequisites: Localized[];
  /** Sample behind the main evidence (evidence strength) and its minimum. */
  sample: { n: number; min: number };
  /** Promotional candidates are dropped for excluded offerings; diagnostic ones are kept. */
  promotional: boolean;
  meta: Record<string, unknown>;
};

export interface Detector {
  id: string;
  /** Sector packs that run it ('*' = all). */
  sectors: string[];
  requires: string[];
  minQuality: Partial<Record<QualityDomain, 'ok' | 'limited'>>;
  /** Skipped in exploratory mode (needs fine segmentation, T11). */
  needsSegmentation?: boolean;
  detect(c: DetectContext): OpportunityCandidate[];
}

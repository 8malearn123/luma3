import type { Localized } from '../util/text';

/**
 * Radar, timing and market contracts (phase 4, §12). See docs/LOOM_CORE.md §10.
 *
 * Third-party text (titles, summaries, imported event names) is untrusted and
 * always travels in fields named untrusted_*: it is data, never instructions.
 */
export const SIGNAL_SOURCE_KINDS = ['rss', 'user_link', 'api'] as const;
export type SignalSourceKind = (typeof SIGNAL_SOURCE_KINDS)[number];

/** §12.1: example (a repeated example) / early_signal / supported_trend (numbers from the source). */
export const EVIDENCE_CLASSES = ['example', 'early_signal', 'supported_trend'] as const;
export type EvidenceClass = (typeof EVIDENCE_CLASSES)[number];
export type Freshness = 'fresh' | 'aging' | 'stale' | 'unknown';

/** A normalised external item before storage. reach_metrics: ONLY what the source provides, else null. */
export type RawSignal = {
  url: string | null;
  untrusted_title: string;
  untrusted_summary: string | null;
  published_at: Date | null;
  region: string | null;
  reach_metrics: Record<string, number> | null;
};

/**
 * Outbound fetch port. Loom never opens sockets itself: the host injects an
 * SSRF-safe fetcher (LUMA: src/server/loom-host/radar.ts → safe-fetch).
 */
export type RadarFetchKind = 'feed' | 'html' | 'calendar' | 'json';
export type RadarFetchResult = { url: string; status: number; contentType: string; text: string };
export class RadarFetchError extends Error {
  constructor(public code: string, message?: string) { super(message ?? code); }
}
export interface RadarFetcher {
  fetch(url: string, kind: RadarFetchKind): Promise<RadarFetchResult>;
  /** Throws RadarFetchError('blocked_url') if the URL is not https/public. */
  assertPublic(url: string): Promise<void>;
}

/** External API provider (search interest, social listening…). Degrades to «غير متصل» when not configured. */
export type ProviderStatus = { state: 'connected' } | { state: 'disconnected'; reason: 'not_configured' | 'unknown_provider' };
export interface SignalApiProvider {
  id: string;
  label: Localized;
  status(): ProviderStatus;
  fetch(query: Record<string, unknown>, fetcher: RadarFetcher): Promise<RawSignal[]>;
}

/** Calendar event kinds of the platform calendar. */
export const CALENDAR_KINDS = ['national', 'religious', 'school_holiday', 'world_day', 'health_awareness', 'local_event', 'commercial'] as const;
export type CalendarKind = (typeof CALENDAR_KINDS)[number];
export type DateBasis = 'official_source' | 'fixed_gregorian' | 'lunar_estimate' | 'approximate' | 'platform_verified';

/** Relevance (rules only, §12.2). score ∈ [0, 1]; reasons explain every point given. */
export type Relevance = {
  score: number;
  factors: { sector: number; audience: number; region: number; opportunity: number };
  reasons: Localized[];
  offering_ids: string[];
  opportunity_id: string | null;
};

/**
 * Timing context handed to the planner (phase 3) for ONE internal opportunity.
 * Events and signals only set timing and message; they never create work on
 * their own (P1, T8). Unverified dates are listed but never usable as dates.
 */
export type TimingEventRef = {
  ref: string;
  origin: 'platform_calendar' | 'owner_calendar';
  title: Localized;
  title_is_untrusted: boolean;
  kind: string;
  region: string | null;
  starts_on: string;
  ends_on: string;
  verification: 'verified' | 'needs_verification';
  usable_for_dates: boolean;
  framing: 'standard' | 'awareness_only';
  attached: boolean;
  source: { name: string; url: string | null };
  relevance: Relevance | null;
};
export type TimingSignalRef = {
  cluster_id: string;
  untrusted_label: string;
  topic: string | null;
  evidence_class: EvidenceClass;
  valid_until: string | null;
  attached: boolean;
  sources: string[];
};
export type TimingContext = {
  opportunity_id: string;
  window: { from: string; to: string };
  events: TimingEventRef[];
  signals: TimingSignalRef[];
  rules: {
    standalone_campaign_allowed: false;
    unverified_dates_usable: false;
    competitor_price_decrease_allowed: false;
    awareness_only_refs: string[];
  };
  notes: Localized[];
};

/** Loom radar, timing and market (phase 4). Public surface re-exported by @/loom. See docs/LOOM_CORE.md §10. */
export * from './types';
export { setRadarFetcher, radarFetcher, registerApiProvider, apiProvider, apiProviders, providerStatus } from './ports';
export { parseFeed, parseHtml, parseIcs, parseJsonCalendar, parseCalendar, parseJsonItems } from './parse';
export { freshnessOf as signalFreshness, isLive, clusterSignals, evidenceClassOf, titleTokens, dedupeKeyOf, jaccard, CLUSTER_WINDOW_DAYS, CLUSTER_JACCARD, LIVE_DAYS, FRESH_DAYS, type ClusterInput, type ClusterResult } from './signals';
export { detectTopic, detectHealthTopics, isAwarenessOnly, SECTOR_TOPICS, HEALTH_TOPICS } from './topics';
export { checkAwarenessRule, AWARENESS_FRAMING, type AwarenessCheckInput, type AwarenessCheckResult, type AwarenessViolation } from './awareness';
export { signalRelevance, eventRelevance, regionFit, cityCode, isTimeable, RELEVANCE_WEIGHTS, type RelevanceContext, type OpenOpportunity } from './relevance';
export { SA_STARTER_CALENDAR, type StarterEvent } from './calendar-sa';
export { ensureStarterCalendar, importOfficialSource, importDueOfficialSources, platformCalendar, reviewPlatformEvent, businessCalendar, setCalendarChoice, adoptedEvents, backoffMs, resetOfficialSourceState, type BusinessCalendarItem } from './calendar';
export { addSource, updateSource, listSources, fetchSource, assessClusters, sweepSources, markStaleClusters, radarView, MAX_SOURCES } from './sources';
export { attachTiming, detachTiming, decideCluster, timingContextFor, applyRadarTiming, timingPlanCommand, recordTimingPlan, type AttachRef } from './timing';
export { marketPriceContext, enforceNoMarketPriceCut, priceProposalAllowed, marketObservationInput, marketObservationPatch, observedOfferings, MARKET_KINDS, COMPARABILITY, COMPARABILITY_REASONS, type PriceContext } from './market';
export * as radarApi from './api';
export { signalSourceInput, signalSourcePatch, clusterDecisionInput, calendarActionInput, calendarReviewInput, platformCalendarImportInput, radarCalendarQuery } from './api';

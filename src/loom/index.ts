/**
 * Loom Marketing Core — public surface. Hosts (the LUMA routes, the seed,
 * later phases) import from here; internals may change. See docs/LOOM_CORE.md.
 *
 * Boundary: nothing under src/loom imports src/server/domains/** or reads
 * public tables (tests/unit/loom-architecture.test.ts, eslint).
 */
export * from './contracts/canonical';
export * from './contracts/connector';
export * from './contracts/opportunity';
export type { ActionCommand, ActionPort, ActionResult } from './contracts/actions';
export { loadDataset, datasetHash } from './dataset';
export { connectorFor, registerConnector } from './connectors/registry';
export { LumaConnector } from './connectors/luma';
export { MetricContext } from './metrics/context';
export { defineMetric, computeMetrics, metricDefinitions, metricDefinition, MetricSet, type MetricDefinition, type MetricValue, type QualityDomain } from './metrics/registry';
import './metrics/v1';
export { qualityGate, type QualityReport, type QualityLevel } from './quality/gate';
export { DETECTORS } from './detectors/v1';
export type { Detector, DetectContext, OpportunityCandidate, EvidenceItem } from './detectors/types';
export { checkCapacity, checkInventory, checkMargin } from './checks';
export { unitEconomics, breakEven, priceIncreaseScenarios, type UnitEconomics } from './economics/unit';
export { selectIntervention } from './interventions/selector';
export { rank, evidenceStrength, FACTOR_LABEL } from './ranking/rank';
export { runEngine, fingerprintOf, type AssessedOpportunity } from './opportunities/engine';
export { persistOpportunities, decide, markConverted, type DecisionInput } from './opportunities/store';
export { renderCard } from './opportunities/render';
export { resolveProfile, setupStatus, SETUP_ITEMS, GOAL_KINDS, EXPLICIT_FACTS, competitorPriceKey, type ResolvedProfile, type ProfileFact, type Goal } from './profile/facts';
export { getPlatformSettings, updatePlatformSettings, platformSettingsPatch, platformSettingsSchema, PLATFORM_DEFAULTS, DEFAULT_RANKING_WEIGHTS, RANKING_FACTORS, type LoomPlatformSettings, type RankingWeights } from './settings/platform';
export { beautyPack, retailPack, restaurantPack, sectorPack, registeredSectorPacks, applyPackQuality, applyMetricOverrides, packVocabulary } from './sector/packs';
export { RETAIL_DETECTORS, orderCapacity } from './sector/retail';
export type { SectorPack, InterventionDef, InterventionId } from './sector/types';
export { analyzeNow, requestAnalysis, runAnalysis, ensureConnection, analysisConnection, ConnectionReviewRequired, ANALYSIS_JOB } from './analysis/run';
// ── Phase 7: host ports, generic connectors, external businesses, outgoing webhooks ──
export { configureLoomRuntime, LoomHttpError, type LoomHttp, type LoomHttpRequest, type LoomHttpResponse, type LoomSecrets } from './runtime';
export { businessHost, type BusinessHost } from './hosts';
export { CsvConnector } from './connectors/generic/csv';
export { RestConnector, restConfigSchema, type RestConfig } from './connectors/generic/rest';
export { StagedConnector, assembleTransactions } from './connectors/generic/staged';
export { mappingSchema, normalizeRows, checkHeader, statusOf, type Mapping, type RevenueBasis } from './connectors/generic/mapping';
export { TEMPLATES, SOURCE_ENTITIES, PII_COLUMN, templateHeader, type SourceEntity } from './connectors/generic/templates';
export { parseCsv, toCsv } from './connectors/generic/csv-parse';
export { stageRecords } from './connectors/generic/store';
export { syncConnection, reviewSnapshot, ingestWebhook } from './connectors/generic/sync';
export * as loomConnections from './connectors/generic/service';
export * as loomBusinesses from './business/service';
export * as loomWebhooks from './webhooks/outgoing';
export { emitLoomEvent, deliverWebhook, WEBHOOK_EVENTS, type WebhookEvent } from './webhooks/outgoing';
export { signBody, verifySignature, newWebhookSecret, SIGNATURE_HEADER, EVENT_ID_HEADER, SignatureError } from './webhooks/signing';
export * as loomApi from './api/service';
export * from './api/schemas';

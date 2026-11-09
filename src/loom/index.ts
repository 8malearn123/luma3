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
export { persistOpportunities, decide, markConverted, type DecisionInput, type DecisionEdits, type ConstraintState } from './opportunities/store';
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
export * as loomMemory from './api/memory';
// Phase 5: memory, measurement and the change aggregator (docs/LOOM_CORE.md §14–§17).
export { recordLadder, recordView, recordReaction, inferBrandFit, brandFitKey, LADDER_STAGES, REACTIONS, type LadderStage, type Reaction } from './memory/ladder';
export { createInitiative, recordExecution, applyEdits, designFor, goalMetricsFor, ARTIFACT_KINDS, GOAL_METRICS, GUARDRAILS, MEASUREMENT_QUALITIES, INITIATIVE_STATUSES, type ArtifactKind, type GoalMetric, type MeasurementQuality } from './memory/initiatives';
export { measureInitiative, MIN_GROUP_FOR_INCREMENTAL, NOT_CAUSAL, type MeasureInput, type Outcome, type ExternalFactor, type CampaignGroups } from './memory/measure';
export { measureBusiness, scheduleMeasurements, MEASURE_JOB } from './memory/outcomes';
export { recordChange, loomEngaged, processChanges, scheduleDueChanges, eventThreshold, windowOccupancy, leaveShrink, CHANGE_RULES, CHANGE_TYPES, CHANGES_JOB, CHANGE_TOPIC, type ChangeInput, type ChangeType, type ProcessSummary } from './memory/changes';
export { setPlanRevisionPort, planRevisionPort, type PlanRevisionPort, type PlanRevisionChange, type PlanRevisionReason, type ApprovedPlanRef, type PlanRevisionResult } from './contracts/plan-revision';
export type { CampaignGroupStats, CampaignGroupStat } from './contracts/connector';
export * from './api/schemas';

// ── Phase 3: planner, validator v2, plans, knowledge (docs/LOOM_CORE.md §10–§13) ──
export * from './contracts/plan';
export { registerLoomHost, loomHost, hasLoomHost, PlannerAiError, type LoomHost, type PlannerAiPort, type PlanStorePort, type PlannerAiCall, type PlannerAiResult, type PlannerPrompt, type HostPlanRef, type ModelTier } from './contracts/host';
export { generatePlanNow, requestPlan, runPlannerRun, PLAN_JOB, RULES_PLANNER_VERSION, validationContextOf } from './planner/run';
export { proposePlanRevision, applyRevision, type RevisionResult } from './planner/revision';
export { loadPlanningContext, freeSlots, type PlanningContext, type PlanOpp } from './planner/context';
export { plannerOutput, type PlannerOutput, type PlannerCard } from './planner/schema';
export { plannerPrompt } from './planner/prompt';
export { runTools, MAX_TOOL_CALLS, type ToolResult } from './planner/tools';
export { validatePlannerOutput, validatePlanDraft, checkText, ensureReviewAt, HEALTH_CLAIM_PATTERNS, type ValidationContext, type ValidationError, type ValidationCode } from './validator/validate';
export { knowledgeLibrary, rankUnits, knowledgeUnitSchema, isStale, type KnowledgeUnit, type KnowledgeQuery } from './knowledge/library';
export { retrieveKnowledge, recordCitations, syncKnowledgeLibrary, resetKnowledgeSync, listKnowledgeUnits, knowledgeTitles } from './knowledge/store';
export * as loomPlannerApi from './api/planner';
export { planRequestInput, commentInput } from './api/planner';
export * from './radar';

// ── Phase 6: learned models (docs/LOOM_CORE.md §24) ──
export * from './models/types';
export { eligibility, temporalSplit, assertNoLeakage, promotionGate, shadowDecision, wape, mae, absBias, brier, logLoss, ece, type Eligibility } from './models/governance';
export { demandData, seasonalNaive, movingAverage, baselinePredict, fitDemand, predictDemand, evaluateDemand, trainDemand, forecastDemand, DEMAND_ALGORITHM, DEMAND_BASELINES, DEMAND_TEST_DAYS, type DemandData, type DemandParams } from './models/demand';
export { returnData, examplesAt, featuresAt, fitBaseline as fitReturnBaseline, fitReturn, predictReturn, evaluateReturn, returnSplit, trainReturn, forecastReturns, RETURN_ALGORITHM, RETURN_BASELINE, RETURN_HORIZON_DAYS, type ReturnParams } from './models/returns';
export { fitResponseBaseline, trainResponse, forecastResponses, responseSplit, RESPONSE_ALGORITHM, RESPONSE_BASELINE, type ResponseObs } from './models/response';
export { aggregateBusiness, trainSector, SECTOR_ALGORITHM, MIN_CONTRIBUTORS, type AggregateCell } from './models/sector';
export { attachForecasts, demandForecastFor, splitSuccessMetrics } from './models/attach';
export { latestForecasts, type ModelVersion } from './models/store';
export { trainBusiness, evaluateShadows, refreshForecasts, promoteVersion, rollback as rollbackModel, trainSectorModel, consentingBusinesses, scheduleModelWork, promoteSectorVersion, rollbackSector, TRAIN_JOB, SHADOW_JOB, FORECAST_JOB, SECTOR_TRAIN_JOB, DEMAND_HORIZON_DAYS, type DatasetLoader, type TrainSummary } from './models/service';
export { fitGlm, fitRidge, solveSpd } from './models/math';
export * as loomModels from './api/models';
export { consentInput, rollbackInput, versionsQuery, platformModelsInput } from './api/models';
export { learnedModelsSchema, LEARNED_MODEL_DEFAULTS, type LearnedModelSettings } from './settings/platform';

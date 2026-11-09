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
export { beautyPack, sectorPack } from './sector/beauty';
export type { SectorPack, InterventionDef, InterventionId } from './sector/types';
export { analyzeNow, requestAnalysis, runAnalysis, ensureConnection, ANALYSIS_JOB } from './analysis/run';
export * as loomApi from './api/service';
export * as loomMemory from './api/memory';
// Phase 5: memory, measurement and the change aggregator (docs/LOOM_CORE.md §10–§12).
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

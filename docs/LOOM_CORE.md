# Loom Marketing Core (phases 1–7)

> Spec: [LOOM_MARKETING_ARCHITECTURE.md](LOOM_MARKETING_ARCHITECTURE.md) (§4–§8, §14, §15, §20). This file documents what is built, the contracts later phases build on, and how to extend them.

Loom core is an independent module in `src/loom/` with its own schema `loom`. It reads LUMA only through the **LUMA connector** (read-only views in schema `loom_export`) and changes LUMA only through LUMA's **ActionPort** (`src/server/loom-host/actions.ts`). The engine is deterministic and rules-based; no AI is involved in phases 1–2. Phase 3 adds the planner (AI wording with a rules fallback), validator v2, plans from opportunities, the knowledge layer and the home page (§10–§13 below).

## 1. Boundary

| Rule | Enforcement |
|---|---|
| Nothing in `src/loom/**` imports `src/server/domains/**`, `src/app/**`, `src/ui/**` or `@/shared/schemas/*` | `tests/unit/loom-architecture.test.ts`, ESLint `no-restricted-imports` on `src/loom/**` |
| Shared infrastructure only from an allowlist: `@/server/db/client`, `@/server/db/schema.generated` (types), `@/server/infra/audit`, `@/server/infra/outbox`, `@/server/http/errors`, `@/server/jobs/registry` (re-exported by `src/loom/db.ts`) | architecture test |
| Query builders and raw SQL in `src/loom` name only `loom.*` and `loom_export.*` relations | architecture test (derives the public table list from `schema.generated.ts`) |
| Loom writes only schema `loom`; LUMA writes (plan items, campaign drafts, price proposals) go through `ActionPort` in the host | `src/server/loom-host/{actions,planner-port}.ts` are the only files importing both `@/loom` and LUMA domains |

The host glue lives outside the core: `src/server/loom-host/{access,actions,planner-port}.ts` (`planner-port.ts` implements the phase-3 `LoomHost` ports: AI through `runAi` and plans through the marketing domain), the routes in `src/app/api/v1/t/[tenantSlug]/loom/*` and `src/app/api/v1/platform/loom/settings`, and the UI in `src/ui/marketing/Loom{Opportunities,Setup}.tsx` and `src/ui/platform/admin/LoomSettingsPage.tsx`.

## 2. Storage decision

Canonical records are **not stored**. Each analysis pulls every canonical entity through the connector and builds a `CanonicalDataset` in memory (`src/loom/dataset.ts`). What is stored is the evidence trail:

| Table (schema `loom`) | Content | Mutability |
|---|---|---|
| `connections`, `source_mappings` | one `luma` connection per business; revenue basis and status map from the connector manifest | updatable |
| `sync_runs` | entity counts and `data_version` of each pull | append-only |
| `analyses` | the job record (queued → running → succeeded / insufficient_data / failed), snapshot hash, data version, mode, result summary | updatable; one live row per business |
| `data_quality_checks` | the §5.4 report (levels per domain, checks, bilingual improvements) | append-only |
| `metric_definitions` | mirror of the code registry, `(key, version)` + definition hash | insert-only (system scope) |
| `metric_values` | every computed value per analysis (`metric_key`, `grain_ref`, `value`, `n`, `status`) | append-only |
| `business_profile_facts`, `business_goals` | §8 facts (computed / explicit / inferred, superseded chain) and goals | facts are superseded, never edited in place |
| `opportunities` | one row per fingerprint: status, bilingual card (`CardContent`), rank, bucket, decision, conversions, subject + reserved volume | updatable |
| `opportunity_evidence`, `opportunity_checks`, `opportunity_events` | evidence rows (`ev_…` ids cited by cards), check results per analysis, lifecycle history | append-only |
| `loom_settings` | platform settings (`platform.<key>` → JSON) with versions | system scope only |
| `planner_runs` (0710) | one row per plan generation / revision: kind, mode, source (ai/rules), `ai_reason`, `ai_run_id`, `candidates_hash`, plan + version ids, validation report, the plan draft | updatable; one live run per (business, kind) |
| `plan_actions` (0710) | the structured actions of a plan version (FK to `plan_versions` and to the opportunity): role, kind, schedule, owner, budget, operational checks, highlighted offerings with real slots and materials, evidence + knowledge refs, revision note | append-only |
| `knowledge_units` (0710) | mirror of the curated library `src/loom/knowledge/units/*.json`, `(id, version)` + content hash | global, insert-only (system scope) |
| `knowledge_citations` (0710) | every use of a unit by a card (`card:<opportunity>`) or a plan action (`plan_action:la_n`), with the planner run and `used_by` (planner_ai / rules) | append-only |
| `opportunity_comments` (0710) | notes on an opportunity (generalises `plan_comments`) | append-only |
| `opportunities.wording` (0710) | the latest validated planner wording (bilingual) with provenance; used only while its `basis` hash matches the card's rules text | updatable |
| `decision_history` (0730) | §10.1 decision ladder: one row per stage per opportunity / initiative | append-only |
| `feedback` (0730) | like / dislike reactions (taste, never an outcome) | append-only |
| `initiatives` (0730) | §10.2 initiative record; `baseline`, `baseline_data_version`, `baseline_analysis_id`, `original_proposal` and the artifact link are frozen by trigger `loom.freeze_initiative` | updatable (frozen columns), never deleted |
| `initiative_executions` (0730) | what was executed (connector once per initiative, or manual) | append-only |
| `outcomes` (0730) | measured results, one per initiative window (`unique (initiative_id, window_to)`) | append-only |
| `change_signals` (0730) | §13 change aggregator, one pending row per `(business, type, scope)` | updatable |

Every business table has `business_id` (= LUMA tenant id) with RLS `app.tenant_visible(business_id)`. `apply_conventions()` covers schema `public` only, so **a migration adding a `loom` table must enable RLS, add the `business_isolation` policy, grant the app role and, if append-only, add the `append_only` trigger and revoke update/delete** (see `0700_loom_core.sql`). Tests truncate schema `loom` in `tests/setup/global-setup.ts`.

## 3. Public contracts (import from `@/loom`)

| Contract | File | Notes |
|---|---|---|
| Canonical model: `CanonicalDataset`, `Offering`, `OfferingRequirement`, `InventoryItem`, `Resource`, `CapacityWindow`, `Transaction(Line)`, `CostFact`, `DemandSignal`, `Review`, `Complaint`, `Customer` (pseudonymous), `Campaign`, `CalendarEvent`, `MarketSignal`, `HostPreferences`, `TransactionStatus`, `CANONICAL_ENTITIES` | `src/loom/contracts/canonical.ts` | instants = epoch ms; dates = business-local `YYYY-MM-DD`; money = minor units; only `fulfilled` is a sale (`isSale`) |
| Connector: `LoomConnector { kind, describe(), healthcheck(), pull(conn, entity, cursor, limit), verifyWebhook? }`, `ConnectorManifest`, `ConnectionRef` (`as_of` fixes "now") | `src/loom/contracts/connector.ts` | read-only; register with `registerConnector()` |
| ActionPort: `ActionCommand` (`plan_action` / `campaign_draft` / `price_proposal`), `ActionResult`, `ActionPort.execute(businessId, cmd)` | `src/loom/contracts/actions.ts` | implemented by the host; Loom builds commands with `loomApi.conversionCommand()` |
| Opportunity card: `CardContent` (stored, bilingual), `OpportunityCard` + `opportunityCardSchema` (rendered §11.1, one language), `OPPORTUNITY_CATEGORIES`, `ACTION_KINDS`, `CHANNELS`, `OPPORTUNITY_STATUSES`, `DECISION_REASONS`, `NON_IDEA_REASONS` | `src/loom/contracts/opportunity.ts` | `renderCard(row, locale)` produces the §11.1 object; extra UI fields come from `cardDetails()` |
| Metrics: `defineMetric(def)`, `computeMetrics(ctx)` → `MetricSet` (`get/value/all`), `MetricContext` (lazy shared views: windows, sales lines, economics, slots, cadence, qualified resources) | `src/loom/metrics/{registry,context,v1}.ts` | values below `min_sample` are withheld (`insufficient_sample`) |
| Quality gate: `qualityGate(ctx)` → `QualityReport { overall, domains[d] = { level, reasons, improve }, checks, exploratory, data_needed, regime_change }` | `src/loom/quality/gate.ts` | domains: sales, customers, capacity, economics, inventory, demand, reviews, campaigns |
| Economics: `unitEconomics()`, `breakEven({price_minor, variable_minor, discount_bp, campaign_cost_minor?, baseline_volume?})`, `priceIncreaseScenarios()` | `src/loom/economics/unit.ts` | T5 vector is a unit test |
| Checks: `checkCapacity(ctx, offeringId, target, reserved)`, `checkInventory(ctx, offeringId, target)`, `checkMargin(ctx, offeringId, { discount_bp })` | `src/loom/checks/index.ts` | `no_recipe` never estimates a count |
| Detectors: `Detector { id, sectors, requires, minQuality, needsSegmentation?, detect(DetectContext) }`, `OpportunityCandidate`, `EvidenceItem`, `DETECTORS` | `src/loom/detectors/{types,v1}.ts` | pure, no I/O |
| Engine: `runEngine(dc, { reserved })` → `{ opportunities: AssessedOpportunity[], suppressed[] }`; `fingerprintOf(detector, subject, today)` | `src/loom/opportunities/engine.ts` | |
| Selection & ranking: `selectIntervention()`, `rank()`, `evidenceStrength()`, `FACTOR_LABEL` | `src/loom/interventions/selector.ts`, `src/loom/ranking/rank.ts` | |
| Lifecycle: `persistOpportunities()`, `decide()`, `markConverted()` | `src/loom/opportunities/store.ts` | |
| Profile: `ProfileFact`, `resolveProfile(facts, goals, platformWeights)` → `ResolvedProfile { goals, prefs, competitor_prices, setup }`, `EXPLICIT_FACTS`, `SETUP_ITEMS`, `GOAL_KINDS` | `src/loom/profile/facts.ts` | |
| Settings: `getPlatformSettings()`, `updatePlatformSettings(actor, patch)`, `platformSettingsSchema`, `PLATFORM_DEFAULTS`, `RankingWeights` | `src/loom/settings/platform.ts` | |
| Pipeline: `requestAnalysis(businessId, …)`, `runAnalysis(id, businessId, { now })`, `analyzeNow(businessId)`, job kind `loom.analysis` | `src/loom/analysis/run.ts`, `src/loom/jobs.ts` | |
| Plan contract: `PlanDraft`, `PlanAction`, `HighlightedOffering`, `PlanRevisionChange`, `PlanKind` | `src/loom/contracts/plan.ts` | bilingual §11.2 plan; the host renders it, Loom keeps actions as rows |
| Host ports: `LoomHost { ai: PlannerAiPort, plans: PlanStorePort }`, `registerLoomHost()`, `loomHost()`, `PlannerAiError` | `src/loom/contracts/host.ts` | implemented by LUMA in `src/server/loom-host/planner-port.ts` |
| Planner: `generatePlanNow()`, `requestPlan()`, `runPlannerRun()`, job `loom.plan`, `loadPlanningContext()`, `plannerOutput` (zod), `plannerPrompt()`, `runTools()` | `src/loom/planner/*` | §10 |
| Revisions: `proposePlanRevision(businessId, planId, reason, changes, opts?)`, `applyRevision()` | `src/loom/planner/revision.ts` | §12 — the entry point for phase 5's change aggregator |
| Validator v2: `validatePlannerOutput()`, `validatePlanDraft()`, `checkText()`, `ensureReviewAt()`, `HEALTH_CLAIM_PATTERNS` | `src/loom/validator/validate.ts` | §11 |
| Knowledge: `knowledgeLibrary()`, `rankUnits()`, `retrieveKnowledge()`, `recordCitations()`, `knowledgeTitles()`, `listKnowledgeUnits()` | `src/loom/knowledge/*` | §13 |
| Phase-3 API service: `loomPlannerApi.*` (`startPlan`, `listPlannerRuns`, `getPlanActions`, `home`, `listComments`, `addComment`, `platformKnowledge`), `planRequestInput`, `commentInput` | `src/loom/api/planner.ts` | |
| Memory (phase 5): `recordLadder`, `recordView`, `recordReaction`, `inferBrandFit`, `LADDER_STAGES`; `createInitiative`, `recordExecution`, `applyEdits`, `goalMetricsFor`; `measureInitiative` (pure), `MIN_GROUP_FOR_INCREMENTAL`, `NOT_CAUSAL`; `measureBusiness`, `MEASURE_JOB` | `src/loom/memory/{ladder,initiatives,measure,outcomes}.ts` | see §10–§11 |
| Change aggregator: `recordChange`, `eventThreshold`, `processChanges`, `scheduleDueChanges`, `CHANGE_RULES`, `CHANGE_TOPIC`, `CHANGES_JOB`, `loomEngaged` | `src/loom/memory/changes.ts` | see §12 |
| PlanRevisionPort: `PlanRevisionPort { approvedPlans(businessId, planIds), proposePlanRevision(businessId, planId, reason, changes) }`, `setPlanRevisionPort()` | `src/loom/contracts/plan-revision.ts` | host adapter `src/server/loom-host/plan-revisions.ts` |
| Connector (optional, phase 5): `LoomConnector.campaignGroups?(conn, campaignId)` → `CampaignGroupStats` | `src/loom/contracts/connector.ts` | LUMA: `loom_export.campaign_groups` |
| API service: `loomApi.*` and request schemas (`goalsInput`, `preferencesInput`, `setupInput`, `decisionInput`, `convertInput`, `opportunityListQuery`, `profilePatchInput`) | `src/loom/api/*` | host-agnostic: `{ businessId, actor, locale }` |
| Radar (phase 4): `timingContextFor`, `checkAwarenessRule`, `clusterSignals`, `evidenceClassOf`, `signalRelevance`/`eventRelevance`, `marketPriceContext`, `enforceNoMarketPriceCut`, `priceProposalAllowed`, `RadarFetcher` port (`setRadarFetcher`), `SignalApiProvider` (`registerApiProvider`), `radarApi.*` | `src/loom/radar/*` | see §10 |
| Learned models (phase 6): `ModelKind`, `ModelStatus`, `MODEL_TRANSITIONS`, `Evaluation`, `GateResult`, `TemporalSplit`, `ForecastRow`; `eligibility`, `temporalSplit`, `assertNoLeakage`, `promotionGate`, `shadowDecision`; `trainDemand` / `trainReturn` / `trainResponse` / `trainSector` (pure); `trainBusiness`, `evaluateShadows`, `refreshForecasts`, `promoteVersion`, `rollbackModel`, `trainSectorModel`; `attachForecasts`, `splitSuccessMetrics`; `SuccessMetric` + `ForecastLabel` (opportunity contract); `loomModels.*` | `src/loom/models/*`, `src/loom/api/models.ts` | see §24 |

### 3.1 Analysis pipeline (rules path)

`POST /loom/analyses` → `loom.analyses` row (queued) + job `loom.analysis` → `runAnalysis`: ensure connection → `loadDataset` (connector pull of every entity; `data_version` = hash of entity versions) → `sync_runs` → `computeMetrics` → `qualityGate` → `data_quality_checks` + `metric_values` → refresh computed/inferred facts → `resolveProfile` → `runEngine` (detectors → capacity/inventory checks → prerequisite conversion → intervention selection → margin/break-even → card → seasonal timing → ranking) → `persistOpportunities` (fingerprint dedupe, lifecycle, evidence, checks, events) → result. With no active offering or `overall = insufficient` the analysis ends `insufficient_data` and lists what is missing. A business pack not in `enabled_sector_packs` fails with `sector_pack_disabled`.

### 3.2 LUMA connector

Reads only `loom_export.*` inside `withTenant(business_id)`. Views are `security_invoker`, filter `tenant_id = app.current_tenant()` (system scope sees nothing) and expose no names, phones or e-mails; customers are `c_<md5>` pseudonyms and `dup_key` is a one-way hash of the normalised contact.

| Entity | Source |
|---|---|
| offerings | services (`service`), product variants (`product`), service packages (`package`), membership plans (`membership`) |
| offering_requirements | `service_material_recipes` (material; `recipe` if approved, else `estimated`), `service_staff` (skill), service duration + buffers (time), `service_resource_requirements` (resource), package items (component) |
| inventory_items | `inventory_items` (`retail` → sellable, `material` → consumable, `both`), 90-day consumption/sale aggregates from `stock_movements` |
| resources / capacity_windows | staff + rooms; windows from working hours, shift overrides, breaks and staff time blocks (`blocked`), **approved leave** (`leave`), occupying bookings (`booked`), the rest `free` — today−28 to today+13 |
| transactions | bookings and product orders, statuses normalised by `LUMA_STATUS_MAP` (`cancel_source` decides customer/business cancellation; a paid order is a sale); net = total − tax − refunds, split pro rata to lines; consistency flag |
| cost_facts | material per offering (complete approved recipe with costed items > recorded `cost_minor` > missing); staff commission per payroll `commission_policies` category (enabled: the highest of base rate, tiers and staff overrides — conservative); marketplace fee from `marketplace_commissions` / `payments.platform_fee_minor` per transaction; payment processing fee **not tracked** (stated as a limitation) |
| demand_signals, reviews, complaints, customers (acquisition source, consents), campaigns, calendar_events (owner-verified), market_signals (freshness), host_preferences | the matching LUMA tables |

## 4. Settings that replace the open decisions

**Platform (`/platform/loom`, capability `platform.loom.manage` — platform owner, MFA, step-up, every key audited as `loom.platform_setting_updated` with before/after):**

| Key | Default | Used by |
|---|---|---|
| `default_ranking_weights` | goal fit .20, evidence .20, impact .20, feasibility .15, cost/effort .10, timing .10, risk .05 (sum = 1, each ≤ .6) | ranking when the business has not customised weights |
| `cost_completeness_threshold` | 0.80 (0.5–1) | quality gate, `margin_check = costs_incomplete`, `missing_cost_blocker` |
| `learned_model_thresholds` | 180 days, 500 completed transactions | phase 6 eligibility per business (below ⇒ baseline only, the «النماذج» tab says why) |
| `learned_models` | `enabled: false`, `auto_promote: true`, `promotion_margin` demand .05 / return .02 / response .05, `guardrail_tolerance` .05, `shadow_days` 14, `retrain_days` 7, `min_measured_outcomes` 30, `sector_models: false` | phase 6 (§24): the platform switch, the declared promotion margins, the shadow period and the retrain cadence |
| `event_sources` | `[]` (id, name, https url, region, kind, licence note, enabled) | official calendars (§10.3): imported daily through safe-fetch; `kind = other` ⇒ imported events need verification |
| `enabled_sector_packs` | `['beauty']` | analysis refuses a disabled pack |

**Business setup checklist (`GET/PUT /loom/setup`, tab «إعداد لووم»):** goals, monthly budget, discount policy (`no_discounts` / max discount), excluded and growth offerings, content tone, ranking weights (accept the platform default or customise, each ≤ .5, sum = 1), shared-training consent (owner only, default false). Each item shows «مطلوب» until an explicit fact confirms it. Analyses still run; every card lists the unconfirmed items in `limitations` and says when the platform default weights were used.

## 5. API v1

All under `/api/v1/t/{slug}/loom`, plan feature `feature.marketing_ai`. Capability mapping (`src/server/loom-host/access.ts`): `loom.view` → `marketing.view | marketing.manage`, `loom.manage` → `marketing.manage`, `loom.connections.manage` → `business.manage`.

| Method & path | Capability | |
|---|---|---|
| `GET data-quality` | view | latest report, localised |
| `GET profile` · `PATCH profile` `{ facts }` | view · manage | facts with kind/source, resolved preferences, goals, offerings, setup |
| `PUT goals` · `PUT preferences` · `GET/PUT setup` | manage (setup GET: view) | `shared_training_consent` needs `business.manage` |
| `POST analyses` → `202 { job_id }` (200 when one is already live) · `GET analyses` · `GET analyses/{id}` | manage · view | |
| `GET opportunities?status=&category=&bucket=&open=` · `GET opportunities/{id}` | view | card + evidence + latest checks + events |
| `POST opportunities/{id}/decision` `{ action: approve | study | defer(reason, until) | dismiss(reason[, note]) | reopen }` | manage | reasons per §10.1; `other` needs a note |
| `POST opportunities/{id}/convert` `{ target: plan_action | campaign_draft(channel?) | price_proposal(proposed_price_minor) }` | manage (+ `feature.campaigns` / `catalog.edit`) | executed by LUMA's ActionPort |
| `GET connections` | `business.manage` | status, last sync, health, manifest |
| `GET/PUT /api/v1/platform/loom/settings` | `platform.loom.manage` (+ step-up for PUT) | |
| `GET home` (phase 3) | view | §11.3 home: situation tiles with trend, data-quality strip + improvements, top ≤5, current plan and this week, pending decisions (opportunities + plan revisions with reason), alerts, setup; `results` is a placeholder for phase 5 |
| `POST plans` `{ kind: monthly|weekly, period_start?, mode?: auto|rules }` → `202 { job_id }` · `GET plans` (planner runs) | manage · view | one live run per kind |
| `GET plans/{id}/actions[?version_id=]` | view | structured actions of a version (checks, materials, real slots, owners, knowledge) + the run's notes |
| `GET/POST opportunities/{id}/comments` `{ body }` | view · manage | notes; `GET opportunities/{id}` now also returns `knowledge` («مرجع المنهجية») and `comments` |
| `GET /api/v1/platform/loom/knowledge` | `platform.loom.manage` | read-only knowledge library with review flags and citation counts |
| `POST opportunities/{id}/feedback` `{ kind: viewed } \| { kind: reaction, reaction: like \| dislike \| none }` | view | phase 5 ladder stages `viewed` / `reacted` |
| `GET initiatives?status=` · `GET initiatives/{id}` · `GET initiatives/{id}/outcome` | view | phase 5 |
| `POST initiatives/{id}/executions` `{ executed_from, executed_to, channel?, audience_size?, actual_cost_minor?, note? }` | manage | manual execution entry |
| `GET results` · `GET decisions?opportunity_id=&initiative_id=` · `GET changes` | view | home summary, ladder, change signals |

`POST opportunities/{id}/decision` with `approve` also accepts `edits: { description?, channel?, period? }` (edit + approve); `GET opportunities[/{id}]` adds `resurfaced: { reason, at } | null`, and the detail adds `ladder`, `reaction` and `initiatives`.

## 6. Lifecycle

Statuses: `detected → assessed → proposed → (studying | deferred | dismissed | accepted) → converted → executed → measured → closed`, plus `superseded` / `expired`. Fingerprint = `detector:subject:YYYY-MM`. On re-analysis: an open one is re-assessed (new evidence and checks, event `reassessed`); one not detected again expires (`conditions_changed`); deferred ones come back after their date; a dismissal for `capacity_staffing` / `capacity_inventory` is **not** an idea failure (`counts_as_idea_failure = false`) and is re-offered (`reopened`, `capacity_available`) once the check passes; other dismissals stay. A promotional candidate blocked by staff time or by materials (covers 0) becomes `capacity_prerequisite` (same fingerprint, bucket `blocked`). Accepted/converted opportunities reserve their target volume, which later capacity checks deduct first. Up to five unblocked opportunities are `top`; the rest `study`.

## 7. Extending

- **Metric:** add a `defineMetric({ key, version: 1, label: {ar, en}, unit, grain, window, formula, requires, min_sample, sectors, domain, compute })` in `src/loom/metrics/v1.ts` (or a new file imported there). Changing a formula ⇒ bump `version`; the new definition is mirrored on the next analysis. Add it to the metrics unit test.
- **Detector:** implement `Detector` in `src/loom/detectors/`, add it to `DETECTORS`, give it thresholds in the sector pack's `detectors` list (a detector absent from the pack never runs) and an ordered intervention list in `pack.interventions[category]` (+ catalogue entries and constraints in `interventions/selector.ts`). Add the category to `OPPORTUNITY_CATEGORIES`, the DB CHECK (new migration) and `loom.category.*` in `src/i18n/messages/loom.ts`. Keep it pure; return evidence that cites metrics, a sample for evidence strength, and `promotional` correctly (promotional candidates honour exclusions and capacity prerequisites).
- **Connector:** implement `LoomConnector` (read-only; normalise statuses to `TransactionStatus`, publish `revenue_basis` and `status_map` in the manifest), `registerConnector()`, and create a `loom.connections` row of that kind. `loadDataset()` follows cursors. Writes stay in the host's ActionPort.
- **Sector pack:** a `SectorPack` (`src/loom/sector/types.ts`) registered in `sector/beauty.ts`'s map, enabled by the platform owner in `/platform/loom`.

## 8. Relation to the existing marketing pipeline

Since phase 3 the Loom planner writes plans into the same `marketing_plans` / `plan_versions` (through the host's `PlanStorePort`, append-only, approval untouched), so the «الخطط» tab shows Loom plans and legacy plans side by side; a Loom version additionally has rows in `loom.plan_actions`, shown in the plan drawer («بنود الخطة من لووم»).

**Deprecated (kept for backward compatibility, data and routes unchanged):**

| Legacy | Replaced by | Status |
|---|---|---|
| `marketing/recommendations` (rules/LLM recommendations, `recommendations` table, `GET/POST /marketing/recommendations*`) | Loom opportunities (`/loom/opportunities`) | hidden from the tab bar; reachable with `?tab=recommendations` behind a deprecation notice |
| «الملخص» tab (`?tab=summary`, `GET /marketing/summary`) | «الرئيسية» (`GET /loom/home`) | default tab is now `home`; summary reachable by URL |
| `marketing.ai_job` kinds `monthly_plan` / `weekly_plan` / `recommendations` (`marketing/pipeline.ts`, `rules.ts`, `validate.ts`, `prompts.ts`) | `loom.plan` job (`POST /loom/plans`) with validator v2 | still callable (`POST /marketing/jobs`, scheduler); the home page uses the Loom planner |

`trend_assessment`, `employee_insights`, campaigns and the trend radar are not affected.

## 9. Tests

`tests/unit/loom-{architecture,engine,economics,connector,metrics-quality,ranking}.test.ts` (pure, synthetic datasets in `tests/helpers/loom-dataset.ts`) and `tests/integration/loom-{core,api,settings}.test.ts` (DB, fixtures in `tests/helpers/loom-core.ts`). §20 coverage on the rules path: T1, T2, T3, T4, T5, T6, T7, T8, T11, T12, T13, T15 (T9, T10, T14 belong to phases 3 and 5).

Phase 3: `tests/unit/loom-planner-{validator,knowledge}.test.ts` and `tests/integration/loom-planner-{plans,api}.test.ts` — planner with a fake AI provider (wording, provenance, model tier, re-ask, read tools, budget overflow), T9 (rules fallback, budget exhausted, previous plans intact), T10 (revision proposal), T14 (unsupported numbers), T12 (planner cache, citations, plan actions, comments), sector-filtered retrieval, citations persisted, weekly slots and materials, home page and routes.

Phase 5: `tests/unit/loom-memory.test.ts` (measurement: MIN_GROUP 30 boundary, quasi, observational + diff-in-diff, guardrails; thresholds; window occupancy; edits diff; revision content) and `tests/integration/loom-memory-{ladder,changes,measure}.test.ts`: ladder stages append-only, reactions stored apart, edit + approve diff, frozen baseline, brand_fit inference + confirmation, T13 ladder + resurfacing (capacity, budget), **T10** (stock movement → outbox → signal → revision version, approved untouched, idempotent), leave > 20 %, thresholds / aggregation / cool-down / no duplicate pending signal, isolation, observational and insufficient measurement, campaign holdout insufficient (< 30) and experimental (30/30).

Phase 4: `tests/unit/loom-radar.test.ts` (freshness/T7, dedupe, deterministic clustering, evidence classes, relevance, awareness rule, starter calendar invariants, ICS, T15 guards) and `tests/integration/loom-radar-{signals,calendar,market}.test.ts` (safe-fetch with a fake transport/resolver: sources, dedupe, backoff sweep, unconfigured API ⇒ disconnected while analysis continues, supported trend from provider numbers, official import, needs_verification never verified, T8, awareness-only, T15, tenant isolation, platform-only management).

## 10. Planner (phase 3, §6.9)

`POST /loom/plans` → `loom.planner_runs` (queued) + job `loom.plan` → `runPlannerRun`:

1. **Context** (`loadPlanningContext`): the latest succeeded analysis, the profile, the canonical dataset (through the connector), and the selected opportunities — accepted/converted first, then open ones by rank (k = 6 monthly, 5 weekly); blocked ones become operational prerequisites. For each: evidence rows (`ev_*`), computed facts (`cf_<ref>_*`: capacity, covers, segment, discount, break-even, margin, cost, free slots, baselines), free slots in the plan window, materials, and up to 2 retrieved knowledge units. Verified calendar events only. `candidates_hash` covers all of it.
2. **AI or rules**: `mode = rules` → rules; no provider → `ai_disconnected`; `consumeBudget` false → `ai_budget_exhausted`; any `PlannerAiError` → `ai_failed`. One budget unit per run.
3. **AI wording** (`PlannerAiPort.run`, strict JSON `plannerOutput`, prompt `loom.planner.monthly` (tier strong) / `loom.planner.weekly` (tier standard), registered in `prompt_versions` with `model_tier`). Input = redacted aggregates only (no names, contacts or customer ids). The cache key = digest(business, prompt, version, candidates hash, snapshot hash, period, round); `runAi` also filters by tenant and model.
4. **Read tools** (optional, `src/loom/planner/tools.ts`): the model may return up to 3 `tool_requests` once — `get_metric(metric_key, grain_ref = business | offering_ref:O<n>)`, `get_segment_size(conditions on O<n> offerings / last visit)`, `get_capacity(offering_ref, window)`. Answered in code from this business's context only (no SQL), segments under 5 customers withheld; results are citable as `tr_<n>`.
5. **Validator v2** (§11) → one bounded re-ask with `validation_errors` → per-item fallback to rules wording (`validation.rules_fallback`), plan head kept only when valid.
6. **Plan assembly** (`buildPlanDraft`, same function for AI and rules): goals, computed baseline, actions (role, schedule inside the period, owner role, budget from computed costs or a validated AI assumption, operational capacity/inventory checks and prerequisites, highlighted offerings with real free slots, sample times and materials for weekly plans, success metrics, evidence + knowledge refs), budget trimmed to the business budget (a weekly plan gets a quarter of the monthly budget), limitations (unconfirmed setup, exploratory data, "targets are goals"), visible notes (e.g. «الذكاء الاصطناعي غير متصل؛ هذه خطة بالقواعد.»). Promotional actions with no free slot are left out with a note.
7. **Store** (`storeVersion`): `PlanStorePort.saveVersion` appends a version (creates the plan if needed; a weekly plan without a monthly plan gets an automatic rules monthly draft as parent), then `loom.plan_actions`, card wording (`opportunities.wording`) and knowledge citations.

Rules fallback (T9) produces exactly the same `PlanDraft` with the engine's bilingual card text; previous versions and the approved version are never touched. The deterministic parts (numbers, budgets, checks, slots) are always computed in code — the model only words.

## 11. Validator v2 (§6.10)

`validatePlannerOutput(output, ValidationContext)` (pure) rejects per item (card / initiative) or the whole plan:

| Check | Code | Effect |
|---|---|---|
| every number in text is declared with an allowed ref (`ev_*`, `cf_*`, `tr_*`) whose value matches (raw, rounded, ×100 %, ÷100 money), or tagged `assumption` (shown on the card) | `unsupported_number`, `unknown_reference`, `reference_value_mismatch` | reject item (T14) |
| proposed spend + computed costs ≤ business budget | `budget_overflow` | reject plan head; rules budget kept |
| `checks_acknowledged` = computed capacity / inventory / margin | `checks_inconsistent` | reject item |
| `no_discounts` (discount words), discount % above the cap, excluded offering names, tone banned words | `discount_not_allowed`, `discount_over_cap`, `excluded_offering`, `banned_word` | reject item |
| health / therapeutic claims: `HEALTH_CLAIM_PATTERNS` (Arabic + English) + the sector pack's `forbiddenClaims` | `health_claim` | reject item |
| promotional item on a blocked offering or with 0 free slots in the window | `full_slot_promotion` | reject item |
| ISO dates only from verified events or inside the plan period; unknown `event_ref` and knowledge refs are dropped (flag) | `unverified_date` | reject item / drop |
| `review_at` | — | `ensureReviewAt` defaults to today + 14 |

`validatePlanDraft(draft, { prefs })` re-checks the final plan (AI or rules): budget, discount actions under `no_discounts`, promotional actions on blocked capacity or zero-slot highlights, checks present.

## 12. Plans, plan actions and revisions (§11.2, T10)

Plans and versions stay in LUMA (`marketing_plans` / `plan_versions`, rendered in the business locale by `toPlanContent` in the host port); Loom stores the structured actions in `loom.plan_actions` per version and the full draft in `planner_runs.result.draft`.

**Contract for phase 5's change aggregator:**

```ts
import { proposePlanRevision } from '@/loom';
await proposePlanRevision(businessId, planId,
  { ar: 'نفدت مادة السيروم', en: 'The serum ran out' },            // reason (Localized or string)
  [{ kind: 'pause_action', action_ref: 'la_1', note: { ar: '…', en: '…' } }],  // PlanRevisionChange[]
  { trigger: 'change', actorId: null });
// → { status: 'proposed', plan_id, version_id, version, approved_version_id, run_id }
//   | { status: 'skipped', reason: 'plan_closed' | 'no_effect' }
```

Changes: `pause_action`, `remove_action`, `reschedule_action`, `add_requirement`, `pause_opportunity` (every action of an opportunity). The function reads the latest version's actions, applies the changes, and appends a NEW version (`change_note = "revision: <reason>"`, `validation.status = revision_proposed`, a `planner_runs` row of kind `revision` with the reason). `approved_version_id` never changes; the plan shows «تعديل بانتظار الاعتماد» and the home page lists it under «بانتظار قرارك» with its reason. Plans without Loom actions (legacy/manual) raise `not_a_loom_plan`. The host ports must be registered (`import '@/server/loom-host/planner-port'`; the job index does it).

## 13. Knowledge layer (§9)

- **Library:** `src/loom/knowledge/units/<id>.json` (schema `knowledgeUnitSchema`: id, version, title, applies_to {sectors, detectors, interventions, channels}, guidance, when_not_to_use, common_mistakes, measurement {primary, design}, examples {good, bad}, source {type, ref, reviewed_at}, owner) listed in `units.ts`. 19 beauty units cover every beauty detector (+ `capacity_prerequisite`) and every intervention of the pack (unit-tested); one retail unit exists to prove sector isolation. Changing a unit ⇒ bump its `version` (a new row; old rows stay).
- **Sync:** `syncKnowledgeLibrary()` mirrors the library into `loom.knowledge_units` (system scope, insert-only) on first retrieval.
- **Retrieval:** `retrieveKnowledge(trx, { sector, detector, intervention, channels, text })` — hard filter in SQL (`sectors @> [sector]` and detector OR intervention in scope) and again in code, then lexical ranking (intervention match, channel overlap, token overlap; generic units last). No unit outside the sector is ever returned. pgvector is not used. Units older than 12 months are flagged `needs_review` (never deleted).
- **Citations:** every card and plan action that uses a unit writes `loom.knowledge_citations` (unit, version, opportunity, plan action, planner run, `used_by`). Cards show them as «مرجع المنهجية» (`GET /loom/opportunities/{id}` → `knowledge`).
- **Platform view:** `/platform/loom` lists the units read-only (`GET /api/v1/platform/loom/knowledge`).

## 14. Decision ladder and initiatives (phase 5, §10.1–§10.2)

- **Ladder:** `loom.decision_history` stores each stage as its own append-only row: `viewed` (once per person per 12 h, usage only), `reacted` (like / dislike, also stored in `loom.feedback`; **never** read by measurement or ranking), `decided` (`approve | edit_approve | study | defer | dismiss | reopen`, categorised reason, `counts_as_idea_failure`), `scheduled` (conversion), `executed`, `completed` (window closed), `measured`. `decide()` writes the `decided` row in the same transaction as the status change; `opportunity_events` keeps the lifecycle history as before.
- **Reasons:** `capacity_staffing`, `capacity_inventory`, `budget`, `timing` are not idea failures (T13) and resurface when the constraint clears: capacity / inventory when the re-run check passes (phase 2), `budget` when the explicit `pref.monthly_budget_minor` fact changed after the decision, `timing` after 30 days. The event is `reopened` with `capacity_available | inventory_available | budget_available | timing_elapsed`; the API returns `resurfaced` and the card shows «عادت للظهور لأن القيد زال». `brand_fit` writes an **inferred** fact `brand.avoid_intervention:<intervention_id>` with `needs_review = true`; it changes nothing until the owner confirms it with `PATCH profile { "brand.avoid_intervention:<id>": true }`, after which `profile.prefs.avoided_interventions` makes the selector skip that intervention.
- **Initiative record:** the convert endpoint (after LUMA's ActionPort ran) calls `createInitiative` in the conversion transaction: one row per `(opportunity, artifact_kind, artifact_ref)` with `baseline` (the latest analysis' metric values for the business and the subject offerings, `success_metrics`, `data_version`, `analysis_id`), `original_proposal` (the card), `user_edits` (diff of the `edit_approve` edits), `approved_version` (card with edits), `goal_metrics` (by category), window, `measurement_design` (`holdout` for campaign drafts, `pre_post_with_control` otherwise). Baseline and proposal are frozen by trigger. `execution`, `results`, `external_factors`, `measurement_quality`, `learnings` are filled later.

## 15. Measurement (§10.3)

`measureInitiative(input)` is pure; `measureBusiness(businessId)` (job `loom.measure`, hourly fan-out `loom.measurement`, dedupe per business and hour) runs it:

1. **Execution:** a campaign initiative whose LUMA campaign has `started_at` gets a connector execution (dates = start … start + attribution window − 1, audience, channel) once; other initiatives need `POST initiatives/{id}/executions`. The window follows the execution.
2. **Completed → measured** once the window has closed (`window_to < today`): outcome row (unique per window), initiative `measured`, opportunity `measured`, ladder rows. Re-running is a no-op.
3. **Quality:**
   | Quality | When |
   |---|---|
   | `experimental` (`causal = true`) | campaign with a randomised holdout and **≥ 30 members in each group** (`MIN_GROUP_FOR_INCREMENTAL`, same as LUMA campaigns): incremental conversion lift and net from `loom_export.campaign_groups` |
   | `quasi` | the same, but a contaminating external factor (stockout / price change / capacity cut on the offering, another campaign) happened in the window |
   | `observational` | not partitionable (plan items, price proposals, content): pre-period of the same length vs the window, control = the other active services, difference-in-differences estimate; always labelled «إشارة محدودة لا علاقة سببية» |
   | `insufficient` | a group below 30 (attributed only, incremental withheld), campaign not sent, no data in either period, or no execution recorded |
4. **Metrics per goal:** completed bookings, contribution margin (null when costs are incomplete), CAC (actual cost ÷ new customers), repeat rate, reactivation (> 90 days gap), period occupancy (quiet-period fill), cross-sell transactions. **Guardrails:** cancellation/no-show rate (+10 pp with ≥ 3), refunds (> 1.5× pre), occupancy overload (> 90 %), rating drop (≥ 0.5, or ≥ 0.3 with overload).
5. **External factors:** processed change signals (inventory / margin / capacity) on the initiative's offerings during the window, other campaigns started in the window, owner-verified calendar events.
6. A measured campaign records a `campaign_result` change signal; processing it writes the inferred fact `learning.initiative:<id>` (the learning the planner can cite).

`loom_export.campaign_groups` (0730) adds the holdout conversions core lacked: per campaign and group (`target` / `holdout`) members, converters, completed bookings net of refunds, cancellations and refunds of bookings created inside the attribution window — the definition of `GET campaigns/{id}/results`.

## 16. Change aggregator (§13)

| Type (`scope`) | Host source | Threshold | Re-runs |
|---|---|---|---|
| `inventory` (`item:<id>`) | `moveStock` → domain event `stock.moved` | available ≤ reorder level (or ≤ 0) **and** the item is in the recipe of a promoted offering | inventory check |
| `occupancy` (`offering:<id>`) | outbox `booking.confirmed` | occupancy of qualified staff > 90 % inside a promoted window (∩ 14-day horizon) | capacity check, `pause_promotion` |
| `capacity` (`staff:<id>`) | `finalizeLeave` → domain event `leave.approved` | the leave removes > 20 % of the qualified staff's scheduled time in a promoted window | capacity check |
| `margin` (`offering:<id>`) | `updateService` / `decidePriceProposal` → `service.economics_changed` | unit margin (price − recorded cost) moves > 10 % | margin check |
| `campaign_result` (`initiative:<id>`) | measurement job | measured | learning fact |

*Promoted* = initiatives `scheduled`/`executing` with a window not yet over, plus accepted / converted / executed opportunities; open opportunities on the same offering are re-checked too. Flow: the host listener (`src/server/loom-host/changes.ts`, imported by `boot.ts`) enqueues the outbox topic `loom.change` in the domain transaction, only for businesses with a Loom connection → `recordChange()` drops events under their threshold, **aggregates** repeats into the single pending signal of the key (partial unique index), and counts events during the **cool-down** after processing as `suppressed` (no new signal) → the periodic `loom.change_aggregation` (5 min) schedules `loom.changes` per business with due signals (`due_at = first_seen + cool-down`, 30 min) → `processChanges()` loads the dataset once, claims each signal with `SKIP LOCKED`, re-runs only the affected checks (no analysis, no model), updates the card's check, appends `opportunity_checks` and a `reassessed` event (`change:<type>`), and marks the signal `processed`, `not_relevant` or `below_threshold`.

**Plan revisions (T10):** when an affected initiative is a `plan_action` whose re-check is no longer ok (or its window is full), the PlanRevisionPort is asked for the approved plans among those plans and proposes a revision for each: the LUMA default (`src/server/loom-host/plan-revisions.ts`) appends an unapproved `plan_versions` row from the approved content with the matching activities annotated (`capacity_note`), the reason appended to `limitations`, `change_note = loom_revision:<type>:<signal>` and `validation.loom_revision`. The approved version and `approved_version_id` never change. **Swap point after phase 3 merges:** register an adapter that calls the planner's `proposePlanRevision(businessId, planId, reason, changes)` with `setPlanRevisionPort()` in `src/server/loom-host/changes.ts` (or replace `lumaPlanRevisions`); nothing in `src/loom` changes.

**Host surface added in LUMA:** `src/server/infra/domain-events.ts` (`emitDomainEvent` / `onDomainEvent`), one call each in `commerce/stock.ts` (`moveStock`), `hr/requests.ts` (`finalizeLeave`), `catalog/service.ts` (`updateService`, `decidePriceProposal`).

## 17. UI

- «النتائج» tab (`src/ui/marketing/LoomResults.tsx`, `LoomResults`): initiatives with status, artifact, window, what was executed (and a manual execution form), measurement design and quality badge with its meaning, metric table (before / during / control / estimate), attributed vs incremental, guardrails, limitations, external factors, learnings.
- **Home embed for the planner:** `<LoomResultsSummary onViewAll={…} />` from `src/ui/marketing/LoomResults.tsx` (data: `GET /loom/results` → `{ counts, latest[≤5], alerts[≤5] }`) renders «نتائج المبادرات» and «تنبيهات جوهرية» (processed change signals with re-checks and proposed plan revisions). `<QualityBadge quality>` and `<DecisionHistory ladder>` are exported too.
- Opportunity card: decision history (ladder), like / dislike (labelled as taste, not outcome), `viewed` on opening details, «عادت للظهور لأن القيد زال» badge.

## 18. Radar, timing and market (phase 4)

Code in `src/loom/radar/*`, public through `@/loom`. Migration `0720_loom_radar`. No AI is involved; every rule below is deterministic and tested.

### 18.1 Storage (schema `loom`)

| Table | Scope | Content | Mutability |
|---|---|---|---|
| `signal_sources` | business | `rss` / `user_link` / `api` (+ `provider`, `query`), `access_basis`, status `active/disabled/error/disconnected`, `consecutive_failures`, `next_fetch_at` (backoff) | updatable; the migration copies existing business `trend_sources` (rss, user_link) |
| `signals` | business | `untrusted_title`, `untrusted_summary`, `url`, `published_at`, `observed_at`, `region`, `topic`, `title_tokens`, `reach_metrics` (only what the source gives, else NULL), `evidence_class`, `valid_until`, `content_hash` (per source), `dedupe_key` (same story across sources), `duplicate_of` | **append-only** |
| `signal_clusters` | business | `cluster_key`, `signal_ids`, counts (stories, sources, live stories), `evidence_class`, `liveness` (`live`/`stale`), `valid_until`, rules `relevance` + score, decision (`open/dismissed/attached/merged`), `opportunity_id`, `planned_ref` | updatable (recomputed, decisions kept) |
| `platform_calendar_events` | platform (read all, system write) | origin `starter/official_source/platform_manual`, `source_name`, `source_url`, `source_ref`, `kind`, `region` (`GLOBAL`, `SA`, `SA:<city>`), trusted `title_ar/en` (curated) or `untrusted_title/description` (imported), dates, `date_basis`, `needs_verification`, verification by the platform owner, `topics`, `status` | DB CHECK: `lunar_estimate`/`approximate` ⇒ `needs_verification` |
| `official_source_state` | platform | per registry source: status, last fetch/success, error, failures, `next_fetch_at`, `last_hash` | system |
| `calendar_choices` | business | `adopted` / `hidden` per platform event | updatable |
| `timing_attachments` | business | `(opportunity_id, ref_kind platform_event/owner_event/signal_cluster, ref_id, framing standard/awareness_only, plan_ref)`, detached rows kept | updatable (detach) |
| `market_observations` | business | `kind` (competitor_offer, price_point, audience_need, channel_norm), `offering_id`, competitor, note, `price_minor`, source manual/link (+ `untrusted_title/excerpt`, `link_status`), `observed_on`, `region`, `comparability` + reasons | updatable (archive) |

RLS `business_isolation` on business tables; platform tables `read_all` + `system_write`; grants and the append-only trigger on `signals` are set in the migration (not by `apply_conventions`).

### 18.2 Signals

- **Sources** through the host's **RadarFetcher port** (`setRadarFetcher`); LUMA registers `src/server/loom-host/radar.ts`, which wraps the existing `safe-fetch` (https, public addresses only, re-validated redirects, size/time limits, a content-type allowlist per kind). `user_link`/`rss` URLs are checked with `assertPublic` before saving (`blocked_url`).
- **API providers** implement `SignalApiProvider { id, label, status(), fetch(query, fetcher) }` (`registerApiProvider`). Built in: `search_interest`, `social_trends`, each configured only by an https endpoint in `LOOM_RADAR_SEARCH_INTEREST_URL` / `LOOM_RADAR_SOCIAL_TRENDS_URL` returning `{ items: [{ title, url, published_at, region?, summary?, metrics? }] }`. Not configured ⇒ the source is stored `disconnected` and shown «غير متصل»; nothing is fetched and the analysis continues on internal data.
- **Freshness** (source date): fresh ≤ 14 d, aging ≤ 45 d, stale > 45 d, unknown when undated or future-dated. Only fresh/aging are **live** (T7). Items older than 180 days are not stored. `valid_until = published + 45 d`.
- **Dedupe**: one row per `(source, content_hash)`; a story already stored from another source gets `duplicate_of` (same `dedupe_key` = hash of sorted, Arabic-normalised title tokens) and counts once.
- **Clustering** (`clusterSignals`, pure): two signals are related when their times (published, else observed) are ≤ 14 days apart AND they share a topic, or their title tokens have Jaccard ≥ 0.5, or they are the same story. Clusters are connected components (independent of input order); `cluster_key` derives from the earliest member, so it is stable while the cluster grows. Components that merge leave the absorbed key as `merged` (decisions on it stay recorded).
- **Evidence class** (live members only): `supported_trend` iff a live item carries numbers supplied by its source; `early_signal` iff ≥ 3 distinct live stories from ≥ 2 sources; else `example`. Counts and growth rates are never estimated.
- **Jobs**: periodic `loom.radar_sweep` (every 15 min) → official sources due (daily, backoff 1 h·2ⁿ⁻¹ ≤ 24 h) and the starter calendar (idempotent), then business sources due (6 h after success, same backoff, a 10-minute claim lease), re-cluster touched businesses, mark clusters past `valid_until` stale. Re-runs store nothing twice.

### 18.3 Calendar

- **Starter calendar** (`calendar-sa.ts`, Nov 2026 – Nov 2027): fixed national days (royal-order dates), WHO/UN days, Hijri occasions as `lunar_estimate` and school calendar/seasons as `approximate` — the last two are **always** `needs_verification` and named with their authority. `ensureStarterCalendar()` never overwrites a reviewed or withdrawn event.
- **Official sources**: registry in platform setting `event_sources`; ICS (`text/calendar`, all-day DTEND exclusive) or JSON `{ events: [{ uid, title, starts_on, ends_on?, region?, kind? }] }`. Imported titles are `untrusted_*`; health topics (`HEALTH_TOPICS`) make an event `health_awareness`. A registry source of kind `other` imports as needs-verification. An unchanged file (same hash) imports nothing.
- **Verification**: `verified` ⇔ `needs_verification = false` (official source, fixed rule, or platform-owner verification with a note — `date_basis = platform_verified`). Unverified events are listed as «يحتاج تحقق», cannot be attached, are not used by the engine and are `usable_for_dates: false` in the timing context.
- **Business view** (`businessCalendar`): active platform events in the business's area (`SA`, `GLOBAL`, own city; other local areas are left out) + owner-verified LUMA calendar events (connector), with relevance, adoption and attachments. The business adopts or hides events.

### 18.4 Relevance and attachment (P1)

- `signalRelevance` / `eventRelevance` (rules): sector .35, audience .25, region .15, link to an OPEN internal opportunity .25, each with a reason. Events link to a promotional opportunity whose window ends ≤ 30 days before the event (never a prerequisite; an awareness-only event never to a discount).
- **Attach** (`attachTiming`): only to an existing opportunity in `detected/assessed/proposed/studying/accepted/deferred`; refused for stale clusters (`signal_stale`), dismissed clusters, unverified events (`needs_verification`) and awareness events on a discount (`awareness_discount_coupling`). Attaching never creates an opportunity, plan item or campaign (T8). **Add to plan** is a separate command (`timingPlanCommand`) executed by the host ActionPort (`plan_action` → a new plan version).
- **Engine**: after `runEngine`, `applyRadarTiming` (in `runAnalysis`) sets `card.timing` from explicit platform-event attachments, else from the first ADOPTED + VERIFIED platform event within 45 days that starts ≤ 30 days after the window (the owner-calendar rule of `attachSeasonalTiming` is unchanged). Awareness events add `:awareness_only` to `event_ref` and the awareness framing to `assumptions`.

**Planner contract** — `timingContextFor(businessId, opportunity: id | { id, period? }) → TimingContext` (also `GET /loom/opportunities/{id}/timing`):

```ts
{ opportunity_id, window: { from, to },
  events: Array<{ ref: 'owner:<id>' | 'platform:<id>', origin, title: {ar,en}, title_is_untrusted, kind, region, starts_on, ends_on,
                  verification: 'verified' | 'needs_verification', usable_for_dates, framing: 'standard' | 'awareness_only',
                  attached, source: { name, url }, relevance }>,   // window.from … window.to + 30 d; owner, adopted or attached; hidden excluded
  signals: Array<{ cluster_id, untrusted_label, topic, evidence_class, valid_until, attached: true, sources }>,  // live attached clusters only
  rules: { standalone_campaign_allowed: false, unverified_dates_usable: false, competitor_price_decrease_allowed: false, awareness_only_refs },
  notes: Array<{ar,en}> }
```

The planner must use only `usable_for_dates` events as dates, treat `untrusted_*`/`title_is_untrusted` text as data, and apply `checkAwarenessRule` to anything tied to an `awareness_only_refs` entry.

### 18.5 Awareness-only rule (validator)

`checkAwarenessRule({ awareness_only, text, discount_bp?, action_kind?, framing? }, pack?) → { ok, violations: ('discount_coupling' | 'therapeutic_claim' | 'missing_awareness_framing')[], messages }` — pure, exported for the phase-3 validator. An event is awareness-only when its kind is `health_awareness` or a topic is in `pack.validation.awarenessOnlyTopics`. Discount wording (خصم، كوبون، %…), a discount action or `discount_bp > 0` ⇒ `discount_coupling`; therapeutic/medical claims (pack `forbiddenClaims` + a fixed list) ⇒ `therapeutic_claim`.

### 18.6 Market observations (T15)

Owner adds observations manually or from a link (fetched through the port; page title/description stored as untrusted). `comparable` needs no reason; `partial`/`not_comparable` need ≥ 1 reason; a price with no matching offering of ours is forced `not_comparable` (`no_matching_offering`). `marketPriceContext()` gives the comparable median and position with `may_decrease_price: false`. **Hard rule:** a competitor price alone never yields a price decrease — the selector only proposes increase reviews, `enforceNoMarketPriceCut()` (in `runAnalysis`) removes any price cut and adds the "context only" limitation to opportunities on observed offerings, and `conversionCommand` refuses a Loom price proposal below the current price (`price_decrease_not_supported`).

### 18.7 API (phase 4)

| Method & path | Capability |
|---|---|
| `GET radar` (sources + connection, providers, live clusters, stale, dismissed) | view |
| `POST radar/sources` · `PATCH radar/sources/{id}` · `POST radar/sources/{id}/fetch` | manage |
| `POST radar/clusters/{id}` `{ action: dismiss | reopen | attach(opportunity_id) | detach | add_to_plan }` | manage |
| `GET radar/calendar?days=` · `POST radar/calendar/{id}` `{ action: adopt | hide | reset | attach | detach | add_to_plan, origin? }` | view · manage |
| `GET/POST market-observations` · `PATCH market-observations/{id}` | view · manage |
| `GET opportunities/{id}/timing` | view |
| `GET/POST /api/v1/platform/loom/calendar` (`{ target: starter | sources, source_id? }`) · `PATCH …/calendar/{id}` (`verify(note, dates?) | withdraw | restore`) | `platform.loom.manage` (+ step-up for writes, audited `loom.calendar_event_reviewed`) |

UI: the «الرادار» tab (`src/ui/marketing/LoomTrends.tsx`: signals by cluster, calendar, market, sources) and `/platform/loom` (`LoomCalendarAdmin`). The old `/marketing/trends` routes and `trend_*` tables still serve the plans pipeline's `trend_assessment`.

---

# Phase 7 — connectors, external businesses, sector packs, webhooks

Migration `0750_loom_connectors`. Everything below is host-agnostic Loom code (`src/loom/**`); the LUMA glue is `src/server/loom-host/{runtime,connection-ops}.ts` and the routes listed in §19.6.

## 19. Generic connectors

### 19.1 Staged connectors

CSV and REST sources are not queryable at analysis time, so they are **staged**: a sync (or an inbound webhook) maps source rows and stores them in `loom.canonical_records`; the connector's `pull()` then assembles canonical records from that store (`src/loom/connectors/generic/staged.ts`). This is the one exception to "canonical records are not stored" (§2): the LUMA connector still reads `loom_export.*` live.

| Piece | File | |
|---|---|---|
| Templates (one per entity: offerings, offering_requirements, inventory_items, resources, capacity_windows, transactions + transaction_lines, cost_facts, demand_signals, reviews, customers) | `generic/templates.ts` | fields, types, required, defaults, bilingual docs, example; `GET …/connections/templates` serves them with an example CSV |
| CSV parser | `generic/csv-parse.ts` | RFC 4180, BOM, CRLF, 50 000 rows |
| Mapping step | `generic/mapping.ts` | `Mapping { timezone, currency, money_unit, columns[entity][field] = source column, status_map[source status] = canonical, revenue_basis { amounts_include_tax, subtract_refunds, total_is_after_discount } }` stored in `source_mappings` (entity `*`, mirrored on `transactions` with the textual revenue basis) |
| Store | `generic/store.ts` | dedupe key `(connection, entity, source_id)`; unchanged `source_version` is not rewritten; deletions are **tombstones** (`deleted_at`); `entity_links` for suspected duplicates (customers with the same hashed contact `dup_key` → 0.9, offerings with the same normalised name and kind → 0.5), status `suggested` until a human confirms/rejects — **never merged automatically** |
| CSV connector `csv_import` | `generic/csv.ts` | each upload = full state of its entity; the cursor per entity is the last applied **file version** (`connections.cursors`); rows may carry `_op=delete` |
| REST connector `rest` | `generic/rest.ts` | `restConfigSchema { base_url (https), health_path, paths[entity], items_field, pagination none / cursor / page, auth none / bearer / header, max_pages }`; every request through the host HTTP port (§13); a partial pull (page limit) never tombstones |
| Sync + review | `generic/sync.ts` | `syncConnection()`, `reviewSnapshot()`, `ingestWebhook()` |
| Lifecycle service | `generic/service.ts` (`loomConnections`) | create / list / get / update / putMapping / upload / action(test, sync, pause, resume) / review / decideLink / templates |

Normalisation: money `major` → ×100 (minor units), `minor` as is; date-times with `Z`/offset are absolute, local ones are read in the mapping timezone; transaction statuses through `status_map` (canonical names are accepted as is; an unmapped status keeps the row **out** of the dataset and blocks review); net revenue = (total, or gross − discount) − tax (if amounts include it) − refunds (if subtracted), split over lines pro rata (`splitNet`); consistency as in the LUMA connector. Derived when the source omits them: `inventory.sold_90d` and customer `visits/first_seen/last_seen` from fulfilled transactions, `resources.skills` → skill requirements, the offering's recorded `cost` → material cost fact. Privacy: customer and transaction files refuse contact-like columns (`PII_COLUMN`: name, phone, email, address, national id…); customers are pseudonymous ids only.

### 19.2 Lifecycle and the review gate (§16 rule)

`review_status`: `not_required` (LUMA) · `pending_mapping` → `pending_review` → `approved` | `rejected`.

1. **Create** (`pending_mapping`). REST: the auth secret and a generated **ingest secret** are sealed through the secrets port; the ingest secret is returned **once**.
2. **Mapping** (`PUT …/mapping`). Changing the mapping (or the REST config) of a reviewed connection sends it back to `pending_mapping` and re-applies files.
3. **Upload / test**. Uploads are validated against the template + mapping (missing columns, types, enums, PII columns, unmapped statuses); invalid content is not kept.
4. **Sync now** → staging → **first-snapshot review**: the dataset is built through the connector exactly as an analysis would, the quality gate (with the business's sector-pack quality model) runs on it, and blockers are listed: `no_active_offerings`, `no_transactions`, `unmapped_statuses`, `quality_insufficient`, `inconsistent_transactions` (> 20 %). No blockers ⇒ `pending_review`.
5. **Confirmation** by the owner (`business.manage`) or the platform owner (external businesses): `approve` only from `pending_review`. The first approved connection becomes the business's **primary source** (`primary_source`, one per business).
6. Analyses (`analysisConnection()` in `analysis/run.ts`) read the primary source only if it is approved and not paused; otherwise they end `failed` / `connection_review_required`. LUMA tenants without a primary source keep the LUMA connection; external businesses have no default.

Status, last sync, last error, health (`action test`), record counts (live / tombstoned per entity), sync runs (`sync_runs.kind = sync | ingest | analysis`), files, links and the review are returned by `GET …/connections/{id}`. **No view contains a secret** (only `has_secret`, `has_ingest_secret`).

### 19.3 Inbound webhooks

`POST /api/v1/loom/ingest/{connection}` (REST connections). Headers `X-Loom-Signature: t=<unix>,v1=<hex HMAC-SHA256(ingest secret, "<t>.<raw body>")>` and `X-Loom-Event-Id`. Body `{ "events": [{ "entity": "<template entity>", "op": "upsert" | "delete", "data": { <source row> } }] }` (≤ 1000 events, ≤ 1 MB). The path id is resolved in system scope only to find the business and secret; after `RestConnector.verifyWebhook()` (constant-time compare, ±300 s replay window) everything runs in `withTenant(business)`. Idempotent by event id (`loom.ingest_events`, append-only): a repeat returns `200 { duplicate: true }`; new events `202`; bad / missing signature or stale timestamp `401`; unknown connection `404`; paused `409`; no mapping `409 mapping_required`. Events are incremental (no tombstones except explicit deletes).

### 19.4 Contract change (additive)

`LoomConnector.verifyWebhook?(req, ctx?: WebhookContext)` — `WebhookContext = { conn, secret, now?, toleranceSec? }`; `SourceEvent` gained optional `data` and `event_id`.

### 19.5 Tests

`tests/unit/loom-connectors.test.ts` (parser, templates, normalisation, revenue basis, signatures, retail pack), `tests/integration/loom-connectors-csv.test.ts` (validation, mapping, status normalisation, revenue basis, dedupe/tombstones/links, review gate, external business E2E with the retail pack, isolation), `…-rest.test.ts` (REST through the safe fetcher incl. blocked hosts and DNS rebinding, secrets, ingest valid/invalid/replay/idempotent, outgoing signing/retry/log, LUMA tenant routes), `…-extraction.test.ts` (§14).

### 19.6 API

Tenant (`/api/v1/t/{slug}/loom`, `loom.connections.manage` → `business.manage`, plan feature `feature.marketing_ai`):

| Method & path | |
|---|---|
| `GET connections` · `POST connections` `{ kind: csv_import \| rest, name, config?, secret? }` | list (status, review, last sync, errors, counts, health, manifest) · create (`ingest_secret` once) |
| `GET connections/templates` | import templates |
| `GET connections/{id}` · `PATCH` `{ name?, config?, secret?, rotate_ingest_secret? }` · `POST` `{ action: test \| sync \| pause \| resume }` | detail · update · lifecycle |
| `POST\|PUT connections/{id}/mapping` · `POST connections/{id}/files` `{ entity, filename, content }` · `POST connections/{id}/review` `{ decision, note?, primary? }` · `POST connections/{id}/links` `{ link_id, status }` | mapping step · CSV upload · first-snapshot confirmation · duplicate decision |
| `GET webhooks` · `POST webhooks` `{ url, events[] }` · `DELETE webhooks/{id}` | outgoing endpoints + delivery log (signing secret once) |
| `GET sector-pack` (`loom.view`) · `PUT sector-pack` `{ sector_pack }` | pack, vocabulary, enabled packs |

Platform (`/api/v1/platform/loom/businesses`, `platform.loom.manage`, MFA; create needs step-up): `GET`/`POST` businesses · `GET`/`PATCH`/`POST {action:'analyze'}` `businesses/{b}` · the same connection, mapping/files/review/links and webhook routes under `businesses/{b}/…` · `GET businesses/{b}/opportunities`.

Inbound: `POST /api/v1/loom/ingest/{connection}` (signature only, no session).

## 20. Businesses outside LUMA

`loom.businesses (id, host 'luma' | 'external', name, sector_pack, timezone, currency, city, locale, status)` with RLS on `id`. An **external business** is a Loom-only business: no row in `tenants` or any LUMA table. Its `id` is its RLS scope id — `withTenant(id)` sets `app.tenant_id`, and every `loom.*` policy (`app.tenant_visible(business_id)`) isolates it exactly like a tenant (no loom table has a foreign key to `tenants`).

Host tables that reference `tenants` are avoided (`src/loom/hosts.ts`):

| Need | LUMA tenant | External business |
|---|---|---|
| Audit (`loomAudit`) | `audit_logs` (tenant id) | `loom.audit_events` (append-only, secrets redacted) + platform action in `audit_logs` (tenant null) |
| Jobs (`scheduleForBusiness`) | `job_runs.tenant_id` | system-scope job with `business_id` in the payload; handlers verify it with `jobBusiness()` (must be an active external business) and retry until the scheduling transaction is visible |

Managed by the platform owner in `/platform/loom` («منشآت خارج لوما»): create (enabled packs only), connect (CSV / REST / webhooks), review the first snapshot, analyze, read opportunities and data quality, outgoing webhooks. `startExternalAnalysis()` uses the same pipeline; the review gate is enforced by the analysis itself.

**Not built (self-serve):** sign-in for external users (an identity provider or API keys per external business mapped to `loom.view / loom.manage / loom.connections.manage`), per-business API tokens for `loomApi` over HTTP, billing/usage limits, and decisions/conversions for external businesses (their `ActionPort` belongs to their own system — the outgoing webhooks are the hand-off; `loomApi.decideOpportunity` audits into `audit_logs` and is LUMA-only for now).

## 21. Sector packs

Registry `src/loom/sector/packs.ts` (importing it registers every pack and the retail detectors): `beauty` (1.0.0), `retail` (1.0.0), `restaurant` (0.1.0 **skeleton**: vocabulary, capacity model, generic detectors only). `SectorPack` gained optional `label`, `metrics.overrides` (stricter `min_sample` → `applyMetricOverrides`), `quality.core` (the domains that decide `overall` with sales → `applyPackQuality`; retail: sales + inventory instead of staff schedules) and `params`.

**Retail** — capacity = sellable inventory + order preparation (`staff`/`generic` free minutes ÷ `prep_min_per_order`) + delivery (`vehicle` free minutes ÷ `delivery_min_per_order`), `orderCapacity()`; unknown when no windows exist (stated in the card, never assumed). Metrics `retail.order_capacity_next14`, `retail.basket_size`, `retail.units_sold_90d`. Detectors (`src/loom/sector/retail.ts`, pure): `retail_slow_mover_bundle` (slow mover + best-selling product with a positive known margin), `stockout_risk` (new category; cover < `cover_days_below` or at the reorder level → `restock`), `reorder_before_promotion` (a verified calendar event within `horizon_days` and best sellers that will not cover `event_uplift` × demand → `capacity_prerequisite` / `restock`; the event never creates a promotion by itself), `basket_cross_sell` (product pairs in the same basket, lift ≥ `min_lift`, ≥ `min_co_baskets`) plus the generic margin, missing-cost, presentation, conversion, loyalty and campaign detectors. Interventions reuse the engine's ids with retail wording. Vocabulary ar/en (منتج، طلب، فرع…).

Selection: LUMA tenants `GET/PUT /loom/sector-pack` (writes `loom.businesses`), external businesses at creation/PATCH; only packs in `platform.enabled_sector_packs`. `runAnalysis` uses the chosen pack (else the connector's sector) and refuses a disabled one. The UI shows the pack's vocabulary (tab «الربط والبيانات»).

Category `stockout_risk` was added to `OPPORTUNITY_CATEGORIES`; the DB check on `opportunities.category` is now a format check (validity is enforced in code) so packs can add categories without migrations racing over one CHECK list.

## 22. Host ports and outgoing webhooks

**Ports** (`src/loom/runtime.ts`): `configureLoomRuntime({ http, secrets })`. Loom never opens sockets itself; unconfigured ports fail closed. LUMA (`src/server/loom-host/runtime.ts`, loaded by `boot.ts`) wires `http` to the SSRF-safe fetcher (`safeFetch` now also takes `method: 'POST'`, `body`, `headers`; POSTs never follow redirects) and `secrets` to AES-256-GCM (`encryptSecret`/`decryptSecret`).

**Outgoing webhooks** (`src/loom/webhooks/outgoing.ts`): `loom.webhook_endpoints` (https URL, events, sealed secret, ≤ 5 active) and `loom.webhook_deliveries` (the delivery log: status pending / delivered / failed, attempts, last HTTP status, last error, times). `emitLoomEvent(trx, businessId, type, key, data)` — types `plan.ready`, `opportunity.created`, `plan.revision_proposed`, `outcome.measured`; event id = hash(type, key), idempotent per endpoint. Each delivery is a job `loom.webhook_delivery` (6 attempts, the jobs framework's exponential backoff); requests are signed exactly like inbound ones (`X-Loom-Signature`, `X-Loom-Event-Id`, `X-Loom-Event-Type`). `opportunity.created` is emitted by `runAnalysis` for opportunities first detected by the analysis. **For phases 3 and 5:** call `emitLoomEvent(trx, businessId, 'plan.ready' | 'plan.revision_proposed', planVersionId, {...})` and `'outcome.measured'` inside the transaction that commits the plan version / outcome. Events only: approving a plan or an opportunity never sends a campaign.

## 23. Extraction readiness

See [LOOM_EXTRACTION.md](LOOM_EXTRACTION.md). `tests/integration/loom-connectors-extraction.test.ts` revokes the runtime role's access to schema `public` and runs CSV sync → review → approval → analysis → opportunities for an external business: the pipeline touches no LUMA table.

# Phase 6 — learned models (experimental)

## 24. Learned models and their governance (§10.4–§10.5)

Layer 2 of §10.4: baselines first, then small explainable models, only where they beat the baseline on a strict temporal split. Pure TypeScript, deterministic (no randomness: zero / mean initialisation, fixed order; synthetic test data is seeded), no new dependency. Everything is behind the platform switch `learned_models.enabled` (default off) and labelled «تجريبي».

### 24.1 Kinds, baselines and models (`src/loom/models/*`, pure)

| Kind | Grain | Baseline(s) | Learned | Primary metric · guardrails (lower is better) |
|---|---|---|---|---|
| `demand_forecast` (`demand.ts`) | offering × local date × hour (completed units, zero-filled over the observed hours, ≤ 365 days) | `seasonal_naive_4w` (same weekday + hour, last 4 weeks at/before the origin) and `moving_average_28d`; the gate uses the **better** of the two | `poisson_glm_v1`: ridge Poisson regression (offering, weekday, hour, offering×weekday, offering×hour, two nested recent-level effects), recency-weighted (half-life 120 d); coefficients = multiplicative effects (`explain`) | WAPE on daily totals per offering · hourly MAE, |bias| |
| `return_probability` (`returns.ts`) | customer (pseudonymous) at a reference date; label = a visit within 45 days | `historical_rate_cohort`: return rate per cohort (recency 5 buckets × visits-in-365-days 3 buckets), shrunk to the overall rate | `logistic_ridge_v1`: cohort + standardised recency, frequency, tenure, recency ÷ usual gap, single-visit flag, average spend | Brier · log loss, ECE (10 bins) |
| `intervention_response` (`response.ts`) | measured outcome (phase 5 `loom.outcomes`, not `insufficient`): relative change of the primary goal metric, keyed by the card's intervention and category | `historical_mean_by_intervention` (shrunk, 3 pseudo-observations) | `ridge_linear_v1` (intervention + category effects) **only** with ≥ `min_measured_outcomes`; otherwise the kind stays baseline | MAE · |mean error| |

Numerics: `math.ts` (`solveSpd` Cholesky with jitter, `fitGlm` ridge Newton/IRLS with step halving for Poisson/logistic, `fitRidge`).

**Temporal split** (`governance.temporalSplit`, `assertNoLeakage`): demand — T = yesterday − 28 days, train ≤ T, test (T, yesterday]; return — T = yesterday − 45 days, test = customers at reference T labelled in (T, T + 45], training references T − 45 − 14k (their labels end ≤ T); response — the latest 20 % of outcomes by measurement date (≥ 5) are the test set. Never random. Unit tests change the data after T and check the fitted parameters do not move.

**Eligibility** (`governance.eligibility`): days since the first completed sale ≥ `learned_model_thresholds.min_days` and completed transactions ≥ `min_completed_transactions`. Below: nothing is trained, the run is stored as `ineligible` with bilingual reasons and the business keeps the baseline.

### 24.2 Governance

- **Gate** (`promotionGate`): primary(candidate) ≤ primary(ref) × (1 − margin) for ref ∈ {best baseline, active version} — the active version is re-evaluated on the candidate's test window (only if its own T ≤ the new T, else `active_not_comparable` ⇒ fail); every guardrail ≤ ref × (1 + `guardrail_tolerance`); a reference of 0 cannot be beaten. Failing candidates are retired (`gate_failed`), with the full gate result stored.
- **Shadow**: a passing candidate becomes `shadow` (a previous shadow is `superseded`) for `shadow_days` (return: ≥ 46 days so the 45-day outcome can be realised; response: ≥ 30 days and ≥ 3 new outcomes). Its predictions and the reference's (active version or baseline) are stored in `shadow_predictions`. `evaluateShadows` compares both on realised data (no margin, guardrail tolerance applies, minimum realised points); pass ⇒ `active` (the previous active is retired `replaced`) when `auto_promote`, fail ⇒ `shadow_failed`; still pending 60 days after the end ⇒ retired.
- **Manual promotion** (`promoteVersion`, `loom.manage`) never bypasses a gate: candidate → shadow only if its gate passed; shadow → active only once the shadow evaluation passed.
- **Rollback** (`rollback`, one click): retire the active version (`rollback`) and restore the version it replaced (`retired_reason = replaced`, once active); a rolled-back version is never restored again; no such version ⇒ the baseline. Forecasts of a retired version disappear at once (read filter).
- **Audit**: every status change is a `model_events` row (created, shadow_started, shadow_evaluated, activated, retired, rollback, restored) and an audit entry (`loom.model_*` in `audit_logs`, or `loom.audit_events` for external businesses).
- **Determinism / idempotency**: a candidate with the same kind, algorithm and data hash is not stored twice (`skipped`).

### 24.3 Storage (migration `0740_loom_models`)

| Table | Content | Mutability |
|---|---|---|
| `model_versions` | business model (or sector model: `business_id` null + `sector`), kind, algorithm, version, status, training window, `split_at`, `test_to`, data hash + data version, params (the exact served artifact), metrics (`candidate`, `baseline`, `active` on the test window, `n_train`, `explain`), gate, shadow window + result, promoted/retired | training record frozen by trigger `loom.guard_model_version`, which also enforces the transitions (candidate → shadow/retired, shadow → active/retired, active → retired, retired → active only for a once-active version); one active and one shadow per scope + kind (partial unique indexes); never deleted |
| `model_events` | the audit of status changes | append-only |
| `model_training_runs` | every attempt: `trained` / `ineligible` / `disabled` / `skipped` / `failed`, eligibility, per-kind summary | append-only |
| `forecasts` | batch, kind, source `model` \| `baseline`, version, subject, horizon, value, 90 % interval | append-only; trigger `loom.forecast_from_active` refuses a model forecast whose version is not the business's **active** one |
| `shadow_predictions` | shadow vs reference predictions per subject and period | append-only |

RLS `business_isolation` on `business_id` for all five (sector rows, `business_id` null, are visible in system scope only).

### 24.4 Forecasts on cards and plans

`refreshForecasts()` computes, per kind, forecasts from the **active** version or else the labelled baseline: demand daily per offering for 14 days, returning customers within 45 days (all customers and per offering's past customers), expected response per (intervention, category). `runAnalysis` calls it (when the switch is on; errors never fail the analysis) and `attachForecasts()` adds **separate** `success_metrics` entries: `{ metric_key: 'forecast.demand_units@offering:<id>' | 'forecast.returning_customers@offering:<id>' | 'forecast.intervention_response@intervention:<id>', baseline: null, target: <forecast>, target_kind: 'model_forecast', forecast: { source, model_kind, algorithm, model_version_id, version, low, high, interval: 0.9, horizon, unit } }`. Proposed goals are never modified; the schema refuses a `forecast` label on a goal and a forecast entry without one (`successMetricSchema`). Plan actions copy the card metrics; the plan-level `success_metrics` are goals only. The `quiet_capacity` detector adds the demand forecast as an assumption when one exists and works unchanged without it (`DetectContext.forecasts` is optional).

### 24.5 Consent and sector models

Shared-training consent is the explicit fact `consent.shared_training` (default false; the fact chain records who/when) and is audited (`loom.shared_training_consent`). `trainSectorModel(sector)` (job `loom.sector_train`, weekly when `sector_models` is on) loads **only** businesses whose current explicit consent is true, reduces each to counts per (reference date, cohort, tenure bucket, single-visit flag) — no customer or business id, no amounts — needs ≥ 3 contributors, and trains `sector_logistic_v1` vs the pooled cohort rate with the same split and gate; stored with `business_id` null, contributors count in the metrics. Platform owner: `GET/POST /api/v1/platform/loom/models` (train, promote after the shadow period, rollback; step-up, audited). **Not yet:** sector models are not served to businesses (no business consumes them as a prior); they are trained, gated and governed only.

### 24.6 Jobs

`loom.train` (per business; manual or scheduled), `loom.shadow_eval`, `loom.forecast_refresh`, `loom.sector_train`; periodic `loom.model_work` (hourly): for businesses with a succeeded analysis in the last 30 days, schedules training when the last run is older than `retrain_days` (dedupe per business and day), shadow evaluations that are due and a daily forecast refresh.

### 24.7 API (`/api/v1/t/{slug}/loom/models`, plan feature `feature.marketing_ai`)

| Method & path | Capability | |
|---|---|---|
| `GET models` | view | switch, thresholds, eligibility (status, history days, completed transactions, reasons), per kind: serving (model / baseline), active, shadow, candidates and recent versions with metrics vs baseline and active, gate, shadow result; consent; recent events |
| `GET models/versions?kind=` · `GET models/forecasts` | view | registry · latest forecasts (active versions or labelled baselines) |
| `POST models/versions/{id}/promote` · `POST models/rollback { model_kind }` · `POST models/train` | manage | 409 `gate_not_passed` / `shadow_not_passed` / `no_active_model` |
| `GET models/consent` · `PUT models/consent { shared_training_consent }` | view · manage **and** owner (`business.manage`) | 403 `owner_only` otherwise |

UI: tab «النماذج» (`src/ui/marketing/LoomModels.tsx`, «تجريبي»): eligibility and why, per kind what serves forecasts, versions with metrics against the baseline and the active version, gate and shadow, promote, rollback with confirmation, latest forecasts («ليست أهدافًا»), the consent explained. Cards list forecasts apart from goals («التوقعات (تجريبي)», source + version + interval). `/platform/loom`: the `learned_models` settings card and the sector models list. i18n `src/i18n/messages/loom_models.ts`.

### 24.8 Tests

`tests/unit/loom-models.test.ts`: numerics, baselines (exact values), temporal split and no leakage (data after T does not move the parameters), learned vs baseline on seeded synthetic histories (`tests/helpers/loom-models.ts`: demand WAPE ≥ 5 % better than the best baseline, return Brier ≥ 2 % better), gate (must beat both; guardrail regression blocks; zero reference), shadow decision, transitions, response threshold, sector minimum contributors, forecasts attached as separate labelled entries + schema. `tests/integration/loom-models.test.ts`: switch off, eligibility from the platform thresholds (a real LUMA salon ⇒ ineligible with reasons), candidate → shadow → active on realised data with events and audit, shadow forecasts never served, idempotent retraining, forecasts on the real analysis' cards from the active version, DB refusal of a non-active forecast, gate vs the active version, manual promotion refused, rollback (previous version, then baseline) with capability checks, append-only tables and frozen versions, T12 isolation, consent default false / owner only / audited, sector training excluding non-consenting and withdrawn businesses and invisible to tenants.

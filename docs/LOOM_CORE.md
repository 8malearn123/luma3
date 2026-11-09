# Loom Marketing Core (phases 1–3)

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
| API service: `loomApi.*` and request schemas (`goalsInput`, `preferencesInput`, `setupInput`, `decisionInput`, `convertInput`, `opportunityListQuery`, `profilePatchInput`) | `src/loom/api/*` | host-agnostic: `{ businessId, actor, locale }` |

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
| `learned_model_thresholds` | 180 days, 500 completed transactions | phase 6 (stored now) |
| `event_sources` | `[]` (id, name, https url, region, kind, licence note, enabled) | phase 4 official calendars |
| `enabled_sector_packs` | `['beauty']` | analysis refuses a disabled pack |

**Business setup checklist (`GET/PUT /loom/setup`, tab «إعداد لووم»):** goals, monthly budget, discount policy (`no_discounts` / max discount), excluded and growth offerings, content tone, ranking weights (accept the platform default or customise, each ≤ .5, sum = 1), shared-training consent (owner only, default false). Each item shows «مطلوب» until an explicit fact confirms it. Analyses still run; every card lists the unconfirmed items in `limitations` and says when the platform default weights were used.

## 5. API v1 (phases 1–2)

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

# Loom Marketing Core (phases 1–2, 5)

> Spec: [LOOM_MARKETING_ARCHITECTURE.md](LOOM_MARKETING_ARCHITECTURE.md) (§4–§8, §14, §15, §20). This file documents what is built, the contracts later phases build on, and how to extend them.

Loom core is an independent module in `src/loom/` with its own schema `loom`. It reads LUMA only through the **LUMA connector** (read-only views in schema `loom_export`) and changes LUMA only through LUMA's **ActionPort** (`src/server/loom-host/actions.ts`). The engine is deterministic and rules-based; no AI is involved in phases 1–2.

## 1. Boundary

| Rule | Enforcement |
|---|---|
| Nothing in `src/loom/**` imports `src/server/domains/**`, `src/app/**`, `src/ui/**` or `@/shared/schemas/*` | `tests/unit/loom-architecture.test.ts`, ESLint `no-restricted-imports` on `src/loom/**` |
| Shared infrastructure only from an allowlist: `@/server/db/client`, `@/server/db/schema.generated` (types), `@/server/infra/audit`, `@/server/infra/outbox`, `@/server/http/errors`, `@/server/jobs/registry` (re-exported by `src/loom/db.ts`) | architecture test |
| Query builders and raw SQL in `src/loom` name only `loom.*` and `loom_export.*` relations | architecture test (derives the public table list from `schema.generated.ts`) |
| Loom writes only schema `loom`; LUMA writes (plan items, campaign drafts, price proposals) go through `ActionPort` in the host | `src/server/loom-host/actions.ts` is the only file importing both `@/loom` and LUMA domains |

The host glue lives outside the core: `src/server/loom-host/{access,actions}.ts`, the routes in `src/app/api/v1/t/[tenantSlug]/loom/*` and `src/app/api/v1/platform/loom/settings`, and the UI in `src/ui/marketing/Loom{Opportunities,Setup}.tsx` and `src/ui/platform/admin/LoomSettingsPage.tsx`.

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
| Memory (phase 5): `recordLadder`, `recordView`, `recordReaction`, `inferBrandFit`, `LADDER_STAGES`; `createInitiative`, `recordExecution`, `applyEdits`, `goalMetricsFor`; `measureInitiative` (pure), `MIN_GROUP_FOR_INCREMENTAL`, `NOT_CAUSAL`; `measureBusiness`, `MEASURE_JOB` | `src/loom/memory/{ladder,initiatives,measure,outcomes}.ts` | see §10–§11 |
| Change aggregator: `recordChange`, `eventThreshold`, `processChanges`, `scheduleDueChanges`, `CHANGE_RULES`, `CHANGE_TOPIC`, `CHANGES_JOB`, `loomEngaged` | `src/loom/memory/changes.ts` | see §12 |
| PlanRevisionPort: `PlanRevisionPort { approvedPlans(businessId, planIds), proposePlanRevision(businessId, planId, reason, changes) }`, `setPlanRevisionPort()` | `src/loom/contracts/plan-revision.ts` | host adapter `src/server/loom-host/plan-revisions.ts` |
| Connector (optional, phase 5): `LoomConnector.campaignGroups?(conn, campaignId)` → `CampaignGroupStats` | `src/loom/contracts/connector.ts` | LUMA: `loom_export.campaign_groups` |
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

## 5. API v1 (phases 1–2, 5)

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

The plans/recommendations pipeline (`src/server/domains/marketing/*`, `ai_jobs`) is unchanged and still produces plans and recommendations from `rules.ts` / the LLM. Loom opportunities are produced by the new engine and shown in the «الفرص» tab; conversions append plan versions or create campaign drafts / price proposals through the existing domain functions. Moving recommendations and plans onto Loom opportunities is phase 3 (planner + plan_actions).

## 9. Tests

`tests/unit/loom-{architecture,engine,economics,connector,metrics-quality,ranking}.test.ts` (pure, synthetic datasets in `tests/helpers/loom-dataset.ts`) and `tests/integration/loom-{core,api,settings}.test.ts` (DB, fixtures in `tests/helpers/loom-core.ts`). §20 coverage on the rules path: T1, T2, T3, T4, T5, T6, T7, T8, T11, T12, T13, T15 (T9, T14 belong to phase 3).

Phase 5: `tests/unit/loom-memory.test.ts` (measurement: MIN_GROUP 30 boundary, quasi, observational + diff-in-diff, guardrails; thresholds; window occupancy; edits diff; revision content) and `tests/integration/loom-memory-{ladder,changes,measure}.test.ts`: ladder stages append-only, reactions stored apart, edit + approve diff, frozen baseline, brand_fit inference + confirmation, T13 ladder + resurfacing (capacity, budget), **T10** (stock movement → outbox → signal → revision version, approved untouched, idempotent), leave > 20 %, thresholds / aggregation / cool-down / no duplicate pending signal, isolation, observational and insufficient measurement, campaign holdout insufficient (< 30) and experimental (30/30).

## 10. Decision ladder and initiatives (phase 5, §10.1–§10.2)

- **Ladder:** `loom.decision_history` stores each stage as its own append-only row: `viewed` (once per person per 12 h, usage only), `reacted` (like / dislike, also stored in `loom.feedback`; **never** read by measurement or ranking), `decided` (`approve | edit_approve | study | defer | dismiss | reopen`, categorised reason, `counts_as_idea_failure`), `scheduled` (conversion), `executed`, `completed` (window closed), `measured`. `decide()` writes the `decided` row in the same transaction as the status change; `opportunity_events` keeps the lifecycle history as before.
- **Reasons:** `capacity_staffing`, `capacity_inventory`, `budget`, `timing` are not idea failures (T13) and resurface when the constraint clears: capacity / inventory when the re-run check passes (phase 2), `budget` when the explicit `pref.monthly_budget_minor` fact changed after the decision, `timing` after 30 days. The event is `reopened` with `capacity_available | inventory_available | budget_available | timing_elapsed`; the API returns `resurfaced` and the card shows «عادت للظهور لأن القيد زال». `brand_fit` writes an **inferred** fact `brand.avoid_intervention:<intervention_id>` with `needs_review = true`; it changes nothing until the owner confirms it with `PATCH profile { "brand.avoid_intervention:<id>": true }`, after which `profile.prefs.avoided_interventions` makes the selector skip that intervention.
- **Initiative record:** the convert endpoint (after LUMA's ActionPort ran) calls `createInitiative` in the conversion transaction: one row per `(opportunity, artifact_kind, artifact_ref)` with `baseline` (the latest analysis' metric values for the business and the subject offerings, `success_metrics`, `data_version`, `analysis_id`), `original_proposal` (the card), `user_edits` (diff of the `edit_approve` edits), `approved_version` (card with edits), `goal_metrics` (by category), window, `measurement_design` (`holdout` for campaign drafts, `pre_post_with_control` otherwise). Baseline and proposal are frozen by trigger. `execution`, `results`, `external_factors`, `measurement_quality`, `learnings` are filled later.

## 11. Measurement (§10.3)

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

## 12. Change aggregator (§13)

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

## 13. UI

- «النتائج» tab (`src/ui/marketing/LoomResults.tsx`, `LoomResults`): initiatives with status, artifact, window, what was executed (and a manual execution form), measurement design and quality badge with its meaning, metric table (before / during / control / estimate), attributed vs incremental, guardrails, limitations, external factors, learnings.
- **Home embed for the planner:** `<LoomResultsSummary onViewAll={…} />` from `src/ui/marketing/LoomResults.tsx` (data: `GET /loom/results` → `{ counts, latest[≤5], alerts[≤5] }`) renders «نتائج المبادرات» and «تنبيهات جوهرية» (processed change signals with re-checks and proposed plan revisions). `<QualityBadge quality>` and `<DecisionHistory ladder>` are exported too.
- Opportunity card: decision history (ladder), like / dislike (labelled as taste, not outcome), `viewed` on opening details, «عادت للظهور لأن القيد زال» badge.

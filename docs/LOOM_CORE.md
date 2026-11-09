# Loom Marketing Core (phases 1–2, radar phase 4)

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
| API service: `loomApi.*` and request schemas (`goalsInput`, `preferencesInput`, `setupInput`, `decisionInput`, `convertInput`, `opportunityListQuery`, `profilePatchInput`) | `src/loom/api/*` | host-agnostic: `{ businessId, actor, locale }` |
| Radar (phase 4): `timingContextFor`, `checkAwarenessRule`, `clusterSignals`, `evidenceClassOf`, `signalRelevance`/`eventRelevance`, `marketPriceContext`, `enforceNoMarketPriceCut`, `priceProposalAllowed`, `RadarFetcher` port (`setRadarFetcher`), `SignalApiProvider` (`registerApiProvider`), `radarApi.*` | `src/loom/radar/*` | see §10 |

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
| `event_sources` | `[]` (id, name, https url, region, kind, licence note, enabled) | official calendars (§10.3): imported daily through safe-fetch; `kind = other` ⇒ imported events need verification |
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

`tests/unit/loom-{architecture,engine,economics,connector,metrics-quality,ranking}.test.ts` (pure, synthetic datasets in `tests/helpers/loom-dataset.ts`) and `tests/integration/loom-{core,api,settings}.test.ts` (DB, fixtures in `tests/helpers/loom-core.ts`). §20 coverage on the rules path: T1, T2, T3, T4, T5, T6, T7, T8, T11, T12, T13, T15 (T9, T10, T14 belong to phases 3 and 5).

Phase 4: `tests/unit/loom-radar.test.ts` (freshness/T7, dedupe, deterministic clustering, evidence classes, relevance, awareness rule, starter calendar invariants, ICS, T15 guards) and `tests/integration/loom-radar-{signals,calendar,market}.test.ts` (safe-fetch with a fake transport/resolver: sources, dedupe, backoff sweep, unconfigured API ⇒ disconnected while analysis continues, supported trend from provider numbers, official import, needs_verification never verified, T8, awareness-only, T15, tenant isolation, platform-only management).

## 10. Radar, timing and market (phase 4)

Code in `src/loom/radar/*`, public through `@/loom`. Migration `0720_loom_radar`. No AI is involved; every rule below is deterministic and tested.

### 10.1 Storage (schema `loom`)

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

### 10.2 Signals

- **Sources** through the host's **RadarFetcher port** (`setRadarFetcher`); LUMA registers `src/server/loom-host/radar.ts`, which wraps the existing `safe-fetch` (https, public addresses only, re-validated redirects, size/time limits, a content-type allowlist per kind). `user_link`/`rss` URLs are checked with `assertPublic` before saving (`blocked_url`).
- **API providers** implement `SignalApiProvider { id, label, status(), fetch(query, fetcher) }` (`registerApiProvider`). Built in: `search_interest`, `social_trends`, each configured only by an https endpoint in `LOOM_RADAR_SEARCH_INTEREST_URL` / `LOOM_RADAR_SOCIAL_TRENDS_URL` returning `{ items: [{ title, url, published_at, region?, summary?, metrics? }] }`. Not configured ⇒ the source is stored `disconnected` and shown «غير متصل»; nothing is fetched and the analysis continues on internal data.
- **Freshness** (source date): fresh ≤ 14 d, aging ≤ 45 d, stale > 45 d, unknown when undated or future-dated. Only fresh/aging are **live** (T7). Items older than 180 days are not stored. `valid_until = published + 45 d`.
- **Dedupe**: one row per `(source, content_hash)`; a story already stored from another source gets `duplicate_of` (same `dedupe_key` = hash of sorted, Arabic-normalised title tokens) and counts once.
- **Clustering** (`clusterSignals`, pure): two signals are related when their times (published, else observed) are ≤ 14 days apart AND they share a topic, or their title tokens have Jaccard ≥ 0.5, or they are the same story. Clusters are connected components (independent of input order); `cluster_key` derives from the earliest member, so it is stable while the cluster grows. Components that merge leave the absorbed key as `merged` (decisions on it stay recorded).
- **Evidence class** (live members only): `supported_trend` iff a live item carries numbers supplied by its source; `early_signal` iff ≥ 3 distinct live stories from ≥ 2 sources; else `example`. Counts and growth rates are never estimated.
- **Jobs**: periodic `loom.radar_sweep` (every 15 min) → official sources due (daily, backoff 1 h·2ⁿ⁻¹ ≤ 24 h) and the starter calendar (idempotent), then business sources due (6 h after success, same backoff, a 10-minute claim lease), re-cluster touched businesses, mark clusters past `valid_until` stale. Re-runs store nothing twice.

### 10.3 Calendar

- **Starter calendar** (`calendar-sa.ts`, Nov 2026 – Nov 2027): fixed national days (royal-order dates), WHO/UN days, Hijri occasions as `lunar_estimate` and school calendar/seasons as `approximate` — the last two are **always** `needs_verification` and named with their authority. `ensureStarterCalendar()` never overwrites a reviewed or withdrawn event.
- **Official sources**: registry in platform setting `event_sources`; ICS (`text/calendar`, all-day DTEND exclusive) or JSON `{ events: [{ uid, title, starts_on, ends_on?, region?, kind? }] }`. Imported titles are `untrusted_*`; health topics (`HEALTH_TOPICS`) make an event `health_awareness`. A registry source of kind `other` imports as needs-verification. An unchanged file (same hash) imports nothing.
- **Verification**: `verified` ⇔ `needs_verification = false` (official source, fixed rule, or platform-owner verification with a note — `date_basis = platform_verified`). Unverified events are listed as «يحتاج تحقق», cannot be attached, are not used by the engine and are `usable_for_dates: false` in the timing context.
- **Business view** (`businessCalendar`): active platform events in the business's area (`SA`, `GLOBAL`, own city; other local areas are left out) + owner-verified LUMA calendar events (connector), with relevance, adoption and attachments. The business adopts or hides events.

### 10.4 Relevance and attachment (P1)

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

### 10.5 Awareness-only rule (validator)

`checkAwarenessRule({ awareness_only, text, discount_bp?, action_kind?, framing? }, pack?) → { ok, violations: ('discount_coupling' | 'therapeutic_claim' | 'missing_awareness_framing')[], messages }` — pure, exported for the phase-3 validator. An event is awareness-only when its kind is `health_awareness` or a topic is in `pack.validation.awarenessOnlyTopics`. Discount wording (خصم، كوبون، %…), a discount action or `discount_bp > 0` ⇒ `discount_coupling`; therapeutic/medical claims (pack `forbiddenClaims` + a fixed list) ⇒ `therapeutic_claim`.

### 10.6 Market observations (T15)

Owner adds observations manually or from a link (fetched through the port; page title/description stored as untrusted). `comparable` needs no reason; `partial`/`not_comparable` need ≥ 1 reason; a price with no matching offering of ours is forced `not_comparable` (`no_matching_offering`). `marketPriceContext()` gives the comparable median and position with `may_decrease_price: false`. **Hard rule:** a competitor price alone never yields a price decrease — the selector only proposes increase reviews, `enforceNoMarketPriceCut()` (in `runAnalysis`) removes any price cut and adds the "context only" limitation to opportunities on observed offerings, and `conversionCommand` refuses a Loom price proposal below the current price (`price_decrease_not_supported`).

### 10.7 API (phase 4)

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

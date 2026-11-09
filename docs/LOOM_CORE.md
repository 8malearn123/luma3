# Loom Marketing Core (phases 1–2)

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

---

# Phase 7 — connectors, external businesses, sector packs, webhooks

Migration `0750_loom_connectors`. Everything below is host-agnostic Loom code (`src/loom/**`); the LUMA glue is `src/server/loom-host/{runtime,connection-ops}.ts` and the routes listed in §10.6.

## 10. Generic connectors

### 10.1 Staged connectors

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

### 10.2 Lifecycle and the review gate (§16 rule)

`review_status`: `not_required` (LUMA) · `pending_mapping` → `pending_review` → `approved` | `rejected`.

1. **Create** (`pending_mapping`). REST: the auth secret and a generated **ingest secret** are sealed through the secrets port; the ingest secret is returned **once**.
2. **Mapping** (`PUT …/mapping`). Changing the mapping (or the REST config) of a reviewed connection sends it back to `pending_mapping` and re-applies files.
3. **Upload / test**. Uploads are validated against the template + mapping (missing columns, types, enums, PII columns, unmapped statuses); invalid content is not kept.
4. **Sync now** → staging → **first-snapshot review**: the dataset is built through the connector exactly as an analysis would, the quality gate (with the business's sector-pack quality model) runs on it, and blockers are listed: `no_active_offerings`, `no_transactions`, `unmapped_statuses`, `quality_insufficient`, `inconsistent_transactions` (> 20 %). No blockers ⇒ `pending_review`.
5. **Confirmation** by the owner (`business.manage`) or the platform owner (external businesses): `approve` only from `pending_review`. The first approved connection becomes the business's **primary source** (`primary_source`, one per business).
6. Analyses (`analysisConnection()` in `analysis/run.ts`) read the primary source only if it is approved and not paused; otherwise they end `failed` / `connection_review_required`. LUMA tenants without a primary source keep the LUMA connection; external businesses have no default.

Status, last sync, last error, health (`action test`), record counts (live / tombstoned per entity), sync runs (`sync_runs.kind = sync | ingest | analysis`), files, links and the review are returned by `GET …/connections/{id}`. **No view contains a secret** (only `has_secret`, `has_ingest_secret`).

### 10.3 Inbound webhooks

`POST /api/v1/loom/ingest/{connection}` (REST connections). Headers `X-Loom-Signature: t=<unix>,v1=<hex HMAC-SHA256(ingest secret, "<t>.<raw body>")>` and `X-Loom-Event-Id`. Body `{ "events": [{ "entity": "<template entity>", "op": "upsert" | "delete", "data": { <source row> } }] }` (≤ 1000 events, ≤ 1 MB). The path id is resolved in system scope only to find the business and secret; after `RestConnector.verifyWebhook()` (constant-time compare, ±300 s replay window) everything runs in `withTenant(business)`. Idempotent by event id (`loom.ingest_events`, append-only): a repeat returns `200 { duplicate: true }`; new events `202`; bad / missing signature or stale timestamp `401`; unknown connection `404`; paused `409`; no mapping `409 mapping_required`. Events are incremental (no tombstones except explicit deletes).

### 10.4 Contract change (additive)

`LoomConnector.verifyWebhook?(req, ctx?: WebhookContext)` — `WebhookContext = { conn, secret, now?, toleranceSec? }`; `SourceEvent` gained optional `data` and `event_id`.

### 10.5 Tests

`tests/unit/loom-connectors.test.ts` (parser, templates, normalisation, revenue basis, signatures, retail pack), `tests/integration/loom-connectors-csv.test.ts` (validation, mapping, status normalisation, revenue basis, dedupe/tombstones/links, review gate, external business E2E with the retail pack, isolation), `…-rest.test.ts` (REST through the safe fetcher incl. blocked hosts and DNS rebinding, secrets, ingest valid/invalid/replay/idempotent, outgoing signing/retry/log, LUMA tenant routes), `…-extraction.test.ts` (§14).

### 10.6 API

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

## 11. Businesses outside LUMA

`loom.businesses (id, host 'luma' | 'external', name, sector_pack, timezone, currency, city, locale, status)` with RLS on `id`. An **external business** is a Loom-only business: no row in `tenants` or any LUMA table. Its `id` is its RLS scope id — `withTenant(id)` sets `app.tenant_id`, and every `loom.*` policy (`app.tenant_visible(business_id)`) isolates it exactly like a tenant (no loom table has a foreign key to `tenants`).

Host tables that reference `tenants` are avoided (`src/loom/hosts.ts`):

| Need | LUMA tenant | External business |
|---|---|---|
| Audit (`loomAudit`) | `audit_logs` (tenant id) | `loom.audit_events` (append-only, secrets redacted) + platform action in `audit_logs` (tenant null) |
| Jobs (`scheduleForBusiness`) | `job_runs.tenant_id` | system-scope job with `business_id` in the payload; handlers verify it with `jobBusiness()` (must be an active external business) and retry until the scheduling transaction is visible |

Managed by the platform owner in `/platform/loom` («منشآت خارج لوما»): create (enabled packs only), connect (CSV / REST / webhooks), review the first snapshot, analyze, read opportunities and data quality, outgoing webhooks. `startExternalAnalysis()` uses the same pipeline; the review gate is enforced by the analysis itself.

**Not built (self-serve):** sign-in for external users (an identity provider or API keys per external business mapped to `loom.view / loom.manage / loom.connections.manage`), per-business API tokens for `loomApi` over HTTP, billing/usage limits, and decisions/conversions for external businesses (their `ActionPort` belongs to their own system — the outgoing webhooks are the hand-off; `loomApi.decideOpportunity` audits into `audit_logs` and is LUMA-only for now).

## 12. Sector packs

Registry `src/loom/sector/packs.ts` (importing it registers every pack and the retail detectors): `beauty` (1.0.0), `retail` (1.0.0), `restaurant` (0.1.0 **skeleton**: vocabulary, capacity model, generic detectors only). `SectorPack` gained optional `label`, `metrics.overrides` (stricter `min_sample` → `applyMetricOverrides`), `quality.core` (the domains that decide `overall` with sales → `applyPackQuality`; retail: sales + inventory instead of staff schedules) and `params`.

**Retail** — capacity = sellable inventory + order preparation (`staff`/`generic` free minutes ÷ `prep_min_per_order`) + delivery (`vehicle` free minutes ÷ `delivery_min_per_order`), `orderCapacity()`; unknown when no windows exist (stated in the card, never assumed). Metrics `retail.order_capacity_next14`, `retail.basket_size`, `retail.units_sold_90d`. Detectors (`src/loom/sector/retail.ts`, pure): `retail_slow_mover_bundle` (slow mover + best-selling product with a positive known margin), `stockout_risk` (new category; cover < `cover_days_below` or at the reorder level → `restock`), `reorder_before_promotion` (a verified calendar event within `horizon_days` and best sellers that will not cover `event_uplift` × demand → `capacity_prerequisite` / `restock`; the event never creates a promotion by itself), `basket_cross_sell` (product pairs in the same basket, lift ≥ `min_lift`, ≥ `min_co_baskets`) plus the generic margin, missing-cost, presentation, conversion, loyalty and campaign detectors. Interventions reuse the engine's ids with retail wording. Vocabulary ar/en (منتج، طلب، فرع…).

Selection: LUMA tenants `GET/PUT /loom/sector-pack` (writes `loom.businesses`), external businesses at creation/PATCH; only packs in `platform.enabled_sector_packs`. `runAnalysis` uses the chosen pack (else the connector's sector) and refuses a disabled one. The UI shows the pack's vocabulary (tab «الربط والبيانات»).

Category `stockout_risk` was added to `OPPORTUNITY_CATEGORIES`; the DB check on `opportunities.category` is now a format check (validity is enforced in code) so packs can add categories without migrations racing over one CHECK list.

## 13. Host ports and outgoing webhooks

**Ports** (`src/loom/runtime.ts`): `configureLoomRuntime({ http, secrets })`. Loom never opens sockets itself; unconfigured ports fail closed. LUMA (`src/server/loom-host/runtime.ts`, loaded by `boot.ts`) wires `http` to the SSRF-safe fetcher (`safeFetch` now also takes `method: 'POST'`, `body`, `headers`; POSTs never follow redirects) and `secrets` to AES-256-GCM (`encryptSecret`/`decryptSecret`).

**Outgoing webhooks** (`src/loom/webhooks/outgoing.ts`): `loom.webhook_endpoints` (https URL, events, sealed secret, ≤ 5 active) and `loom.webhook_deliveries` (the delivery log: status pending / delivered / failed, attempts, last HTTP status, last error, times). `emitLoomEvent(trx, businessId, type, key, data)` — types `plan.ready`, `opportunity.created`, `plan.revision_proposed`, `outcome.measured`; event id = hash(type, key), idempotent per endpoint. Each delivery is a job `loom.webhook_delivery` (6 attempts, the jobs framework's exponential backoff); requests are signed exactly like inbound ones (`X-Loom-Signature`, `X-Loom-Event-Id`, `X-Loom-Event-Type`). `opportunity.created` is emitted by `runAnalysis` for opportunities first detected by the analysis. **For phases 3 and 5:** call `emitLoomEvent(trx, businessId, 'plan.ready' | 'plan.revision_proposed', planVersionId, {...})` and `'outcome.measured'` inside the transaction that commits the plan version / outcome. Events only: approving a plan or an opportunity never sends a campaign.

## 14. Extraction readiness

See [LOOM_EXTRACTION.md](LOOM_EXTRACTION.md). `tests/integration/loom-connectors-extraction.test.ts` revokes the runtime role's access to schema `public` and runs CSV sync → review → approval → analysis → opportunities for an external business: the pipeline touches no LUMA table.

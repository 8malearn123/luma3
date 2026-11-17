# Loom extraction readiness

> Spec: [LOOM_MARKETING_ARCHITECTURE.md](LOOM_MARKETING_ARCHITECTURE.md) §4.2 — extract Loom as a service when the first non-LUMA system connects or when analysis load needs its own resources. Details: [LOOM_CORE.md](LOOM_CORE.md) §19–§23.

## What is already independent

| Concern | State |
|---|---|
| Code | `src/loom/**` imports no LUMA domain, route or UI (architecture test + ESLint). Shared infrastructure is an allowlist: DB client, generated types, audit, outbox `schedule`, `AppError`, job registry. |
| Data | Loom reads and writes only schema `loom` (and reads `loom_export` through the LUMA connector). No `loom` table references `tenants`. |
| Businesses | A business is a `business_id` + RLS scope. External businesses exist without any LUMA row (`loom.businesses.host = 'external'`). |
| Connectors | `csv_import` and `rest` (+ signed inbound webhooks) are generic; the LUMA connector is just another `LoomConnector`. |
| Outbound effects | HTTP and secret sealing only through ports (`configureLoomRuntime`); host commands only through `ActionPort`; events to connected systems only through outgoing webhooks. |
| API | `loomApi`, `loomConnections`, `loomBusinesses`, `loomWebhooks` take `{ businessId, actor, locale }`; auth and capability mapping live in the host routes. |
| Proof | `tests/integration/loom-connectors-extraction.test.ts`: with USAGE on schema `public` revoked, an external business runs CSV sync → review → approval → analysis → opportunities. A static check forbids network modules and `tenant_id` / `loom_export` in the generic code. |

## Mechanical steps to extract

1. Move schema `loom` to its own database (the migration files `07xx` apply as is; replace `references users(id)` with plain uuids or a Loom user table).
2. Replace `@/server/db/client` with a Loom client that sets the same `app.tenant_id` / `app.scope` settings (copy `app.tenant_visible`, `app.is_system`, `app.forbid_mutation`, `app.touch_updated_at`).
3. Replace the allowlisted host helpers: audit → `loom.audit_events` for every business (as external businesses do today), jobs → a Loom queue (the handlers already resolve the business from the payload), errors → the same `AppError` shape.
4. Wire the ports: an SSRF-safe fetcher and a KMS-backed secrets port.
5. Expose `loomApi` & co. over HTTP (the route files are thin; auth becomes API keys / OAuth per business with the `loom.view / loom.manage / loom.connections.manage` scopes).
6. LUMA becomes a client: its connector turns into a REST source (or keeps an export endpoint over `loom_export`), and its `ActionPort` receives conversion commands over HTTP (or reacts to outgoing webhooks).

## Not done yet

Self-serve auth for external businesses, per-business API keys, usage limits/billing for external businesses, decisions/conversions from an external system (today: read-only opportunities + outgoing webhooks), and moving `loom_export` behind HTTP.

import type { CanonicalEntity, TransactionStatus } from './canonical';

/**
 * Connector contract (§5.3). Connectors are READ-ONLY: anything that changes
 * the host (campaign drafts, price proposals, plan actions) goes through the
 * host's ActionPort (contracts/actions.ts), never through a connector.
 */

export type ConnectorManifest = {
  kind: string;
  version: string;
  entities: Array<{ entity: CanonicalEntity; fields: string[]; incremental: boolean }>;
  /** How "revenue" is defined for this source (stored in source_mappings.revenue_basis). */
  revenue_basis: string;
  /** Source status → canonical status, per transaction kind (stored in source_mappings.status_map). */
  status_map: Record<string, Record<string, TransactionStatus | `${TransactionStatus}|${TransactionStatus}`>>;
  timezone_source: string;
};

export type ConnectionRef = {
  id: string;
  business_id: string;
  kind: string;
  config: Record<string, unknown>;
  /** Fixes "now" for a deterministic pull (tests, replays). Defaults to the current time. */
  as_of?: Date;
};

export type ConnectionHealth = { status: 'ok' | 'degraded' | 'down'; checked_at: string; detail?: string };

export type PulledRecord = { op: 'upsert' | 'delete'; source_id: string; source_version: string; data: unknown };
export type PullResult = { records: PulledRecord[]; next_cursor: string | null };

export type SourceEvent = {
  entity: CanonicalEntity | (string & {}); source_id: string; op: 'upsert' | 'delete'; at: string;
  /** Raw source row (staged connectors map it with the connection's mapping). */
  data?: unknown;
  /** Idempotency key of the delivery that carried the event. */
  event_id?: string;
};

/** What a connector needs to verify an inbound webhook: the connection and its ingest secret (server-side only). */
export type WebhookContext = { conn: ConnectionRef; secret: string; now?: Date; toleranceSec?: number };

export interface LoomConnector {
  readonly kind: 'luma' | 'csv_import' | 'rest' | (string & {});
  describe(): ConnectorManifest;
  healthcheck(conn: ConnectionRef): Promise<ConnectionHealth>;
  /** Incremental pull with an opaque cursor; records are canonical (already normalised). */
  pull(conn: ConnectionRef, entity: CanonicalEntity, cursor: string | null, limit: number): Promise<PullResult>;
  /** Verifies an inbound webhook (signature, replay window) and returns its events. Throws on an invalid request. */
  verifyWebhook?(req: Request, ctx?: WebhookContext): Promise<SourceEvent[]>;
}

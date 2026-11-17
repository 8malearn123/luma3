import { z } from 'zod';
import { withTenant } from '../../db';
import type { ConnectionHealth, ConnectionRef, SourceEvent, WebhookContext } from '../../contracts/connector';
import { loomHttp, LoomHttpError } from '../../runtime';
import { EVENT_ID_HEADER, SIGNATURE_HEADER, SignatureError, verifySignature } from '../../webhooks/signing';
import { readMapping, StagedConnector } from './staged';
import { SOURCE_ENTITIES, type SourceEntity } from './templates';

/**
 * REST connector (kind `rest`): pulls each mapped entity from a configured
 * HTTPS API (base URL + one path per entity + pagination) and/or receives
 * signed inbound webhooks. Every request goes through the host HTTP port
 * (LUMA: the SSRF-safe fetcher: https only, public addresses only, size and
 * time limits). The auth secret is stored encrypted on the connection and is
 * never returned by the API.
 */
const path = z.string().max(200).regex(/^\/[A-Za-z0-9_\-./]*$/, 'a path starting with /');
const field = z.string().max(60).regex(/^[A-Za-z0-9_.]*$/);

export const restConfigSchema = z.object({
  base_url: z.string().max(300).url().regex(/^https:\/\/[^/?#]+\/?[^?#]*$/, 'https base URL without query'),
  health_path: path.default('/'),
  paths: z.partialRecord(z.enum(SOURCE_ENTITIES), path).default({}),
  items_field: field.default('data'),
  pagination: z.discriminatedUnion('type', [
    z.object({ type: z.literal('none') }).strict(),
    z.object({ type: z.literal('cursor'), cursor_param: field.min(1).default('cursor'), next_field: field.min(1).default('next_cursor') }).strict(),
    z.object({ type: z.literal('page'), page_param: field.min(1).default('page'), size_param: field.min(1).default('per_page'), size: z.number().int().min(1).max(1000).default(100) }).strict(),
  ]).default({ type: 'none' }),
  auth: z.object({ type: z.enum(['none', 'bearer', 'header']), header_name: z.string().regex(/^[A-Za-z0-9-]{1,40}$/).optional() }).strict().default({ type: 'none' }),
  max_pages: z.number().int().min(1).max(200).default(50),
}).strict();
export type RestConfig = z.infer<typeof restConfigSchema>;

const dig = (v: unknown, p: string): unknown => (p ? p.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), v) : v);

export class RestConnector extends StagedConnector {
  readonly kind = 'rest';
  readonly version = 'rest-1.0.0';

  private headers(cfg: RestConfig, secret: string | null): Record<string, string> {
    const h: Record<string, string> = { accept: 'application/json' };
    if (cfg.auth.type === 'bearer' && secret) h.authorization = `Bearer ${secret}`;
    if (cfg.auth.type === 'header' && secret) h[(cfg.auth.header_name ?? 'x-api-key').toLowerCase()] = secret;
    return h;
  }

  private url(cfg: RestConfig, p: string, query: Record<string, string> = {}) {
    const base = new URL(cfg.base_url.endsWith('/') ? cfg.base_url : `${cfg.base_url}/`);
    const u = new URL(p.replace(/^\//, ''), base);
    if (u.host !== base.host) throw new LoomHttpError('invalid_url');
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
    return u.toString();
  }

  /** Healthcheck: mapping present (base) and the API's health path answers with JSON. */
  async healthcheckRemote(conn: ConnectionRef, cfg: RestConfig, secret: string | null): Promise<ConnectionHealth> {
    const checked_at = new Date().toISOString();
    try {
      await loomHttp()({ url: this.url(cfg, cfg.health_path), method: 'GET', headers: this.headers(cfg, secret), accept: /^application\/json\b/i, timeoutMs: 8000 });
    } catch (e) {
      return { status: 'down', checked_at, detail: e instanceof LoomHttpError ? e.code : 'network_error' };
    }
    const mapped = await withTenant(conn.business_id, (trx) => readMapping(trx, conn.business_id, conn.id));
    return mapped ? { status: 'ok', checked_at } : { status: 'degraded', checked_at, detail: 'mapping_missing' };
  }

  /** Fetches every page of one entity (raw source rows). Throws LoomHttpError on transport failures. */
  async fetchEntity(cfg: RestConfig, entity: SourceEntity, secret: string | null): Promise<{ rows: Array<Record<string, unknown>>; complete: boolean }> {
    const p = cfg.paths[entity];
    if (!p) return { rows: [], complete: false };
    const rows: Array<Record<string, unknown>> = [];
    let cursor: string | null = null;
    for (let page = 1; page <= cfg.max_pages; page++) {
      const q: Record<string, string> = {};
      if (cfg.pagination.type === 'cursor' && cursor) q[cfg.pagination.cursor_param] = cursor;
      if (cfg.pagination.type === 'page') { q[cfg.pagination.page_param] = String(page); q[cfg.pagination.size_param] = String(cfg.pagination.size); }
      const res = await loomHttp()({ url: this.url(cfg, p, q), method: 'GET', headers: this.headers(cfg, secret), accept: /^application\/json\b/i, timeoutMs: 15_000, maxBytes: 5_000_000 });
      let json: unknown;
      try { json = JSON.parse(res.text); } catch { throw new LoomHttpError('invalid_json'); }
      const items = Array.isArray(json) ? json : dig(json, cfg.items_field);
      if (!Array.isArray(items)) throw new LoomHttpError('invalid_payload', `no array at ${cfg.items_field}`);
      for (const it of items) if (it && typeof it === 'object') rows.push(it as Record<string, unknown>);
      if (cfg.pagination.type === 'none') return { rows, complete: true };
      if (cfg.pagination.type === 'page' && items.length < cfg.pagination.size) return { rows, complete: true };
      if (cfg.pagination.type === 'cursor') {
        const next = dig(json, cfg.pagination.next_field);
        if (next === null || next === undefined || next === '') return { rows, complete: true };
        cursor = String(next);
      }
    }
    // Page limit reached: the snapshot is partial, so missing records are NOT tombstoned.
    return { rows, complete: false };
  }

  /**
   * Inbound webhook: X-Loom-Signature (HMAC-SHA256 over "<t>.<body>", ±5 min)
   * and X-Loom-Event-Id. Body: { events: [{ entity, op?, data }] } with
   * `data` a source row of that entity (mapped like any other source row).
   */
  async verifyWebhook(req: Request, ctx?: WebhookContext): Promise<SourceEvent[]> {
    if (!ctx) throw new SignatureError('missing_signature');
    const body = await req.text();
    const t = verifySignature(ctx.secret, body, req.headers.get(SIGNATURE_HEADER), { now: ctx.now, toleranceSec: ctx.toleranceSec });
    const eventId = req.headers.get(EVENT_ID_HEADER) ?? '';
    if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(eventId)) throw new WebhookPayloadError('missing_event_id');
    let json: unknown;
    try { json = JSON.parse(body); } catch { throw new WebhookPayloadError('invalid_json'); }
    const events = (json as { events?: unknown }).events;
    if (!Array.isArray(events) || !events.length || events.length > 1000) throw new WebhookPayloadError('invalid_payload');
    return events.map((e, i) => {
      const ev = e as { entity?: unknown; op?: unknown; data?: unknown };
      if (typeof ev.entity !== 'string' || !(SOURCE_ENTITIES as readonly string[]).includes(ev.entity) || !ev.data || typeof ev.data !== 'object') throw new WebhookPayloadError('invalid_event');
      return { entity: ev.entity, op: ev.op === 'delete' ? 'delete' as const : 'upsert' as const, source_id: `${eventId}#${i}`, at: new Date(t * 1000).toISOString(), data: ev.data, event_id: eventId };
    });
  }
}

export class WebhookPayloadError extends Error {
  constructor(public code: string) { super(code); }
}

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { Errors, withTenant, type AuditActor, type Tx } from '../db';
import { loomAudit, scheduleForBusiness } from '../hosts';
import { loomHttp, LoomHttpError, loomSecrets } from '../runtime';
import { EVENT_ID_HEADER, newWebhookSecret, SIGNATURE_HEADER, signBody } from './signing';

/**
 * Outgoing webhooks to the connected system (§15). Events only — approving a
 * plan never sends a campaign; sending stays a separate host command through
 * the ActionPort with the host's own approvals.
 *
 *   emitLoomEvent(trx, business, type, key, data)  → one delivery per active
 *   endpoint subscribed to the type (idempotent per endpoint and event id) +
 *   a `loom.webhook_delivery` job. The job signs (X-Loom-Signature, see
 *   signing.ts), POSTs through the host HTTP port (SSRF-safe in LUMA) and is
 *   retried with the jobs framework's exponential backoff (6 attempts). Every
 *   attempt is recorded on the delivery row (the delivery log).
 */
export const WEBHOOK_EVENTS = ['plan.ready', 'opportunity.created', 'plan.revision_proposed', 'outcome.measured'] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];
export const DELIVERY_JOB = 'loom.webhook_delivery';
export const DELIVERY_MAX_ATTEMPTS = 6;

export const endpointInput = z.object({
  url: z.string().trim().max(500).url().regex(/^https:\/\//, 'https only'),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).max(WEBHOOK_EVENTS.length).refine((x) => new Set(x).size === x.length, { message: 'duplicate event' }),
  description: z.string().trim().max(200).optional(),
}).strict();

type Ctx = { businessId: string; actor: AuditActor };

export const eventIdOf = (type: WebhookEvent, key: string) => `evt_${createHash('sha256').update(`${type}:${key}`).digest('hex').slice(0, 32)}`;

/** Records deliveries for an event inside the caller's transaction. Returns the number of deliveries created. */
export async function emitLoomEvent(trx: Tx, businessId: string, type: WebhookEvent, key: string, data: Record<string, unknown>): Promise<number> {
  const endpoints = await trx.selectFrom('loom.webhook_endpoints').select(['id', 'events']).where('business_id', '=', businessId).where('active', '=', true).execute();
  const targets = endpoints.filter((e) => e.events.includes(type));
  if (!targets.length) return 0;
  const eventId = eventIdOf(type, key);
  const payload = { id: eventId, type, created_at: new Date().toISOString(), business_id: businessId, data };
  let n = 0;
  for (const ep of targets) {
    const row = await trx.insertInto('loom.webhook_deliveries').values({ business_id: businessId, endpoint_id: ep.id, event_id: eventId, event_type: type, payload: JSON.stringify(payload) })
      .onConflict((oc) => oc.columns(['endpoint_id', 'event_id']).doNothing()).returning('id').executeTakeFirst();
    if (!row) continue;
    n++;
    await scheduleForBusiness(trx, businessId, DELIVERY_JOB, { delivery_id: row.id }, { dedupeKey: `loom_webhook:${row.id}`, maxAttempts: DELIVERY_MAX_ATTEMPTS });
  }
  return n;
}

/**
 * One delivery attempt (the job handler). Throws on failure so the jobs
 * framework retries with backoff; the final attempt marks the delivery failed.
 */
export async function deliverWebhook(businessId: string, deliveryId: string, attempt: number, opts: { now?: Date } = {}) {
  const d = await withTenant(businessId, (trx) => trx.selectFrom('loom.webhook_deliveries as d').innerJoin('loom.webhook_endpoints as e', 'e.id', 'd.endpoint_id')
    .select(['d.id', 'd.status', 'd.payload', 'd.event_id', 'd.event_type', 'e.url', 'e.secret_enc', 'e.active']).where('d.business_id', '=', businessId).where('d.id', '=', deliveryId).executeTakeFirst());
  // Not visible yet (scheduled in system scope before the emitting transaction committed): retry.
  if (!d) throw new Error('delivery not found (yet)');
  if (d.status !== 'pending') return { status: d.status };
  if (!d.active) {
    await withTenant(businessId, (trx) => trx.updateTable('loom.webhook_deliveries').set({ status: 'failed', last_error: 'endpoint_inactive' }).where('id', '=', deliveryId).execute());
    return { status: 'failed' };
  }
  const body = JSON.stringify(d.payload);
  const t = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  const headers = { 'content-type': 'application/json', [SIGNATURE_HEADER]: signBody(loomSecrets().open(d.secret_enc), body, t), [EVENT_ID_HEADER]: d.event_id, 'x-loom-event-type': d.event_type };
  let status: number | null = null;
  let error: string | null = null;
  try {
    const res = await loomHttp()({ url: d.url, method: 'POST', headers, body, accept: /.*/, timeoutMs: 10_000, maxBytes: 64_000 });
    status = res.status;
  } catch (e) {
    error = e instanceof LoomHttpError ? `${e.code}${e.message && e.message !== e.code ? `: ${e.message}` : ''}` : (e as Error).message;
    status = e instanceof LoomHttpError ? e.status ?? null : null;
  }
  const ok = error === null;
  const final = !ok && attempt >= DELIVERY_MAX_ATTEMPTS;
  await withTenant(businessId, (trx) => trx.updateTable('loom.webhook_deliveries').set((eb) => ({
    status: ok ? 'delivered' : final ? 'failed' : 'pending', attempts: eb('attempts', '+', 1), last_status: status, last_error: error?.slice(0, 500) ?? null,
    last_attempt_at: new Date(), delivered_at: ok ? new Date() : null,
  })).where('id', '=', deliveryId).execute());
  if (!ok) throw new Error(`webhook delivery failed: ${error}`);
  return { status: 'delivered' };
}

// ── Endpoint management (loom.connections.manage) ───────────────────────────
const view = (e: { id: string; url: string; events: string[]; active: boolean; description: string | null; created_at: Date }) =>
  ({ id: e.id, url: e.url, events: e.events, active: e.active, description: e.description, created_at: e.created_at, has_secret: true });

export async function listEndpoints(c: Pick<Ctx, 'businessId'>) {
  return withTenant(c.businessId, async (trx) => {
    const eps = await trx.selectFrom('loom.webhook_endpoints').select(['id', 'url', 'events', 'active', 'description', 'created_at']).where('business_id', '=', c.businessId).orderBy('created_at').execute();
    const deliveries = await trx.selectFrom('loom.webhook_deliveries').select(['id', 'endpoint_id', 'event_id', 'event_type', 'status', 'attempts', 'last_status', 'last_error', 'last_attempt_at', 'delivered_at', 'created_at'])
      .where('business_id', '=', c.businessId).orderBy('created_at', 'desc').limit(50).execute();
    return { endpoints: eps.map(view), deliveries, events: WEBHOOK_EVENTS };
  });
}

/** Creates an endpoint; the signing secret is returned ONCE and stored encrypted. */
export async function createEndpoint(c: Ctx, input: z.infer<typeof endpointInput>) {
  const secret = newWebhookSecret();
  const row = await withTenant(c.businessId, async (trx) => {
    const n = await trx.selectFrom('loom.webhook_endpoints').select((eb) => eb.fn.countAll<number>().as('n')).where('business_id', '=', c.businessId).where('active', '=', true).executeTakeFirstOrThrow();
    if (Number(n.n) >= 5) throw Errors.conflict('too_many_endpoints', 'At most 5 active webhook endpoints');
    const r = await trx.insertInto('loom.webhook_endpoints').values({ business_id: c.businessId, url: input.url, events: input.events, secret_enc: loomSecrets().seal(secret), description: input.description ?? null, created_by: c.actor.userId })
      .returning(['id', 'url', 'events', 'active', 'description', 'created_at']).executeTakeFirstOrThrow();
    await loomAudit(trx, c.actor, 'loom.webhook_endpoint_created', c.businessId, { targetType: 'loom_webhook_endpoint', targetId: r.id, data: { url: new URL(input.url).host, events: input.events } });
    return r;
  });
  return { endpoint: view(row), signing_secret: secret };
}

export async function deactivateEndpoint(c: Ctx, id: string) {
  return withTenant(c.businessId, async (trx) => {
    const r = await trx.updateTable('loom.webhook_endpoints').set({ active: false }).where('business_id', '=', c.businessId).where('id', '=', id).returning('id').executeTakeFirst();
    if (!r) throw Errors.notFound('webhook endpoint');
    await loomAudit(trx, c.actor, 'loom.webhook_endpoint_deactivated', c.businessId, { targetType: 'loom_webhook_endpoint', targetId: id });
    return { id, active: false };
  });
}

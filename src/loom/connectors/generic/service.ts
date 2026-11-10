import { createHash } from 'node:crypto';
import { z } from 'zod';
import { Errors, withTenant, type AuditActor, type Tx } from '../../db';
import { loomAudit } from '../../hosts';
import { loomSecrets } from '../../runtime';
import { render, type LoomLocale } from '../../util/text';
import { newWebhookSecret } from '../../webhooks/signing';
import { connectorFor } from '../registry';
import { parseCsv, toCsv } from './csv-parse';
import { checkHeader, describeRevenueBasis, mappingSchema, normalizeRows, type Mapping } from './mapping';
import { restConfigSchema } from './rest';
import { readMapping } from './staged';
import { refOf, restConnector, syncConnection } from './sync';
import { SOURCE_ENTITIES, TEMPLATES, templateHeader } from './templates';

/**
 * Connection lifecycle (host-agnostic; the host maps it to
 * loom.connections.manage): create → mapping → upload/test → sync → first
 * snapshot review → owner/platform confirmation → primary source of
 * analyses. Secrets (REST auth, ingest signing secret) are stored encrypted
 * through the host secrets port; the ingest secret is returned once at
 * creation/rotation and no view ever contains a secret.
 */
type Ctx = { businessId: string; actor: AuditActor; locale: LoomLocale };

export const createConnectionInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('csv_import'), name: z.string().trim().min(1).max(120) }).strict(),
  z.object({ kind: z.literal('rest'), name: z.string().trim().min(1).max(120), config: restConfigSchema, secret: z.string().min(8).max(500).optional() }).strict(),
]);
export const updateConnectionInput = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  config: restConfigSchema.optional(),
  secret: z.string().min(8).max(500).nullable().optional(),
  rotate_ingest_secret: z.literal(true).optional(),
}).strict().refine((x) => Object.keys(x).length > 0, { message: 'empty patch' });
export const connectionActionInput = z.object({ action: z.enum(['test', 'sync', 'pause', 'resume']) }).strict();
export const reviewInput = z.object({ decision: z.enum(['approve', 'reject']), note: z.string().trim().max(500).optional(), primary: z.boolean().optional() }).strict();
export const uploadInput = z.object({ entity: z.enum(SOURCE_ENTITIES), filename: z.string().trim().min(1).max(200), content: z.string().min(1).max(900_000) }).strict();
export const linkDecisionInput = z.object({ link_id: z.string().uuid(), status: z.enum(['confirmed', 'rejected']) }).strict();

type Row = {
  id: string; business_id: string; kind: string; name: string; status: string; config: unknown; review_status: string; review: unknown; primary_source: boolean;
  last_sync_at: Date | null; last_error: string | null; health: unknown; record_counts: unknown; secret_enc: string | null; ingest_secret_enc: string | null;
  reviewed_at: Date | null; created_at: Date; cursors: unknown;
};

const STAGED = ['csv_import', 'rest'];

/** Public view of a connection: never a secret, only whether one is set. */
export function connectionView(r: Row) {
  return {
    id: r.id, kind: r.kind, name: r.name || r.kind, status: r.status, review_status: r.review_status, review: r.review, primary_source: r.primary_source,
    last_sync_at: r.last_sync_at, last_error: r.last_error, health: r.health, record_counts: r.record_counts, cursors: r.cursors, reviewed_at: r.reviewed_at, created_at: r.created_at,
    config: r.kind === 'rest' ? r.config : {}, has_secret: !!r.secret_enc, has_ingest_secret: !!r.ingest_secret_enc,
    ingest_path: r.kind === 'rest' ? `/api/v1/loom/ingest/${r.id}` : null, staged: STAGED.includes(r.kind),
  };
}

async function load(trx: Tx, businessId: string, id: string): Promise<Row> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw Errors.notFound('connection');
  const r = await trx.selectFrom('loom.connections').selectAll().where('business_id', '=', businessId).where('id', '=', id).executeTakeFirst();
  if (!r) throw Errors.notFound('connection');
  return r as Row;
}

async function businessDefaults(trx: Tx, businessId: string) {
  const b = await trx.selectFrom('loom.businesses').select(['timezone', 'currency']).where('id', '=', businessId).executeTakeFirst();
  return { timezone: b?.timezone ?? 'Asia/Riyadh', currency: b?.currency ?? 'SAR' };
}

export function templates(locale: LoomLocale) {
  return SOURCE_ENTITIES.map((e) => {
    const t = TEMPLATES[e];
    return {
      entity: e, doc: render(t.doc, locale), key: t.key, csv: toCsv(templateHeader(e), [templateHeader(e).map((h) => t.example[h] ?? '')]),
      fields: t.fields.map((f) => ({ field: f.field, type: f.type, required: !!f.required, values: f.values ?? null, default: f.default ?? null, doc: render(f.doc, locale) })),
    };
  });
}

export async function list(c: Pick<Ctx, 'businessId'>) {
  const rows = await withTenant(c.businessId, (trx) => trx.selectFrom('loom.connections').selectAll().where('business_id', '=', c.businessId).orderBy('created_at').execute());
  const out = [];
  for (const r of rows as Row[]) {
    const last = await withTenant(c.businessId, (trx) => trx.selectFrom('loom.sync_runs').select(['kind', 'status', 'finished_at', 'entities', 'data_version', 'error']).where('business_id', '=', c.businessId).where('connection_id', '=', r.id).orderBy('finished_at', 'desc').limit(1).executeTakeFirst());
    const live = !STAGED.includes(r.kind);
    const health = live ? await connectorFor(r.kind).healthcheck({ id: r.id, business_id: c.businessId, kind: r.kind, config: {} }) : r.health;
    out.push({ ...connectionView(r), health, last_run: last ?? null, manifest: connectorFor(r.kind).describe() });
  }
  return out;
}

/** The service validates its own input (hosts may call it without the route layer). */
function valid<S extends z.ZodTypeAny>(schema: S, input: unknown): z.infer<S> {
  const r = schema.safeParse(input);
  if (!r.success) throw Errors.validation(r.error.issues.map((i) => ({ path: i.path.join('.'), code: i.code, message: i.message })));
  return r.data;
}

export async function create(c: Ctx, raw: z.infer<typeof createConnectionInput>) {
  const input = valid(createConnectionInput, raw);
  const ingest = input.kind === 'rest' ? newWebhookSecret() : null;
  const row = await withTenant(c.businessId, async (trx) => {
    const exists = await trx.selectFrom('loom.connections').select('id').where('business_id', '=', c.businessId).where('kind', '=', input.kind).executeTakeFirst();
    if (exists) throw Errors.conflict('connection_exists', 'This business already has a connection of this kind');
    const r = await trx.insertInto('loom.connections').values({
      business_id: c.businessId, kind: input.kind, name: input.name, status: 'active', review_status: 'pending_mapping',
      config: JSON.stringify(input.kind === 'rest' ? input.config : {}),
      secret_enc: input.kind === 'rest' && input.secret ? loomSecrets().seal(input.secret) : null,
      ingest_secret_enc: ingest ? loomSecrets().seal(ingest) : null,
    }).returningAll().executeTakeFirstOrThrow();
    await loomAudit(trx, c.actor, 'loom.connection_created', c.businessId, { targetType: 'loom_connection', targetId: r.id, data: { kind: input.kind, name: input.name } });
    return r as Row;
  });
  return { connection: connectionView(row), ingest_secret: ingest };
}

export async function get(c: Pick<Ctx, 'businessId' | 'locale'>, id: string) {
  return withTenant(c.businessId, async (trx) => {
    const r = await load(trx, c.businessId, id);
    const mapping = await readMapping(trx, c.businessId, id);
    const files = await trx.selectFrom('loom.import_files').select(['id', 'entity', 'version', 'filename', 'row_count', 'status', 'errors', 'created_at', 'applied_at'])
      .where('business_id', '=', c.businessId).where('connection_id', '=', id).orderBy('created_at', 'desc').limit(50).execute();
    const links = await trx.selectFrom('loom.entity_links').select(['id', 'entity', 'source_id_a', 'source_id_b', 'reason', 'confidence', 'status', 'created_at'])
      .where('business_id', '=', c.businessId).where('connection_id', '=', id).orderBy('confidence', 'desc').limit(50).execute();
    const runs = await trx.selectFrom('loom.sync_runs').select(['id', 'kind', 'status', 'entities', 'error', 'started_at', 'finished_at'])
      .where('business_id', '=', c.businessId).where('connection_id', '=', id).orderBy('finished_at', 'desc').limit(10).execute();
    return { ...connectionView(r), mapping, revenue_basis_text: mapping ? describeRevenueBasis(mapping.revenue_basis) : null, files, links, runs };
  });
}

const RESET_ON_CHANGE = (s: string) => (s === 'not_required' ? s : 'pending_mapping');

export async function update(c: Ctx, id: string, raw: z.infer<typeof updateConnectionInput>) {
  const input = valid(updateConnectionInput, raw);
  const ingest = input.rotate_ingest_secret ? newWebhookSecret() : null;
  const row = await withTenant(c.businessId, async (trx) => {
    const r = await load(trx, c.businessId, id);
    if ((input.config || input.secret !== undefined || ingest) && r.kind !== 'rest') throw Errors.invalid('not_a_rest_connection');
    const patch: Record<string, unknown> = {};
    if (input.name) patch.name = input.name;
    if (input.config) { patch.config = JSON.stringify(input.config); patch.review_status = RESET_ON_CHANGE(r.review_status); }
    if (input.secret !== undefined) patch.secret_enc = input.secret ? loomSecrets().seal(input.secret) : null;
    if (ingest) patch.ingest_secret_enc = loomSecrets().seal(ingest);
    const u = await trx.updateTable('loom.connections').set(patch).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
    await loomAudit(trx, c.actor, 'loom.connection_updated', c.businessId, { targetType: 'loom_connection', targetId: id, data: { fields: Object.keys(patch).map((k) => k.replace(/_enc$/, '')) } });
    return u as Row;
  });
  return { connection: connectionView(row), ingest_secret: ingest };
}

/** The mapping step. Changing the mapping of a reviewed connection sends it back to review (re-sync + re-confirm). */
export async function putMapping(c: Ctx, id: string, input: Mapping) {
  const m = valid(mappingSchema, input);
  return withTenant(c.businessId, async (trx) => {
    const r = await load(trx, c.businessId, id);
    if (!STAGED.includes(r.kind)) throw Errors.invalid('not_a_staged_connection', 'The LUMA connection maps itself (manifest)');
    const values = { revenue_basis: describeRevenueBasis(m.revenue_basis), status_map: JSON.stringify(m.status_map), field_map: JSON.stringify(m) };
    for (const entity of ['*', 'transactions']) {
      await trx.insertInto('loom.source_mappings').values({ business_id: c.businessId, connection_id: id, entity, ...values })
        .onConflict((oc) => oc.columns(['connection_id', 'entity']).doUpdateSet((eb) => ({ ...values, version: eb('loom.source_mappings.version', '+', 1) }))).execute();
    }
    // Uploaded files must be re-applied under the new mapping.
    await trx.updateTable('loom.connections').set({ review_status: RESET_ON_CHANGE(r.review_status), cursors: JSON.stringify({}) }).where('id', '=', id).execute();
    await trx.updateTable('loom.import_files').set({ status: 'valid' }).where('connection_id', '=', id).where('status', '=', 'applied').execute();
    await loomAudit(trx, c.actor, 'loom.mapping_updated', c.businessId, { targetType: 'loom_connection', targetId: id, data: { entities: Object.keys(m.columns), statuses: Object.keys(m.status_map).length, timezone: m.timezone, currency: m.currency } });
    return { mapping: m, revenue_basis_text: values.revenue_basis, review_status: RESET_ON_CHANGE(r.review_status) };
  });
}

/** CSV upload: validated against the template (header, types, statuses, privacy) before it can be applied. */
export async function upload(c: Ctx, id: string, input: z.infer<typeof uploadInput>) {
  return withTenant(c.businessId, async (trx) => {
    const r = await load(trx, c.businessId, id);
    if (r.kind !== 'csv_import') throw Errors.invalid('not_a_csv_connection');
    const mapping = await readMapping(trx, c.businessId, id);
    const provisional: Mapping = mapping ?? { ...(await businessDefaults(trx, c.businessId)), money_unit: 'major', columns: {}, status_map: {}, revenue_basis: { amounts_include_tax: true, subtract_refunds: true, total_is_after_discount: true } };
    const parsed = parseCsv(input.content);
    const header = checkHeader(input.entity, parsed.header, provisional);
    const errors: Array<Record<string, unknown>> = [...parsed.errors.map((e) => ({ row: 0, field: '', code: e })), ...header];
    let rows = 0;
    let unmapped: string[] = [];
    if (!header.length && parsed.header.length) {
      const n = normalizeRows(input.entity, parsed.rows, provisional);
      errors.push(...n.errors);
      rows = n.rows.length;
      unmapped = n.unmapped_statuses;
    }
    const valid = errors.length === 0 && parsed.rows.length > 0;
    const last = await trx.selectFrom('loom.import_files').select((eb) => eb.fn.max('version').as('v')).where('connection_id', '=', id).where('entity', '=', input.entity).executeTakeFirst();
    const f = await trx.insertInto('loom.import_files').values({
      business_id: c.businessId, connection_id: id, entity: input.entity, version: Number(last?.v ?? 0) + 1, filename: input.filename,
      sha256: createHash('sha256').update(input.content).digest('hex'), header: JSON.stringify(parsed.header), row_count: parsed.rows.length,
      status: valid ? 'valid' : 'invalid', errors: JSON.stringify(errors.slice(0, 50)), content: valid ? input.content : '', uploaded_by: c.actor.userId,
    }).returning(['id', 'version', 'status']).executeTakeFirstOrThrow();
    await loomAudit(trx, c.actor, 'loom.import_uploaded', c.businessId, { targetType: 'loom_import_file', targetId: f.id, data: { entity: input.entity, rows: parsed.rows.length, status: f.status } });
    return {
      file_id: f.id, entity: input.entity, version: f.version, status: f.status, rows: parsed.rows.length, valid_rows: rows,
      errors: errors.slice(0, 50), error_count: errors.length, unmapped_statuses: unmapped,
      warnings: parsed.header.filter((h) => h !== '_op' && !Object.values(provisional.columns?.[input.entity] ?? {}).includes(h) && !templateHeader(input.entity).includes(h)).map((h) => ({ code: 'ignored_column', field: h })),
    };
  });
}

export async function action(c: Ctx, id: string, act: z.infer<typeof connectionActionInput>['action']) {
  if (act === 'sync') {
    const r = await syncConnection(c.businessId, id);
    await withTenant(c.businessId, (trx) => loomAudit(trx, c.actor, 'loom.connection_synced', c.businessId, { targetType: 'loom_connection', targetId: id, data: { status: r.status, review_status: r.review_status } }));
    return r;
  }
  if (act === 'test') {
    const r = await withTenant(c.businessId, (trx) => load(trx, c.businessId, id));
    const health = r.kind === 'rest'
      ? await restConnector.healthcheckRemote(refOf(r), restConfigSchema.parse(r.config), r.secret_enc ? loomSecrets().open(r.secret_enc) : null)
      : await connectorFor(r.kind).healthcheck(refOf(r));
    await withTenant(c.businessId, (trx) => trx.updateTable('loom.connections').set({ health: JSON.stringify(health) }).where('id', '=', id).execute());
    return { health };
  }
  return withTenant(c.businessId, async (trx) => {
    const r = await load(trx, c.businessId, id);
    const status = act === 'pause' ? 'paused' : 'active';
    if (act === 'resume' && r.status !== 'paused') throw Errors.conflict('invalid_transition', 'The connection is not paused');
    await trx.updateTable('loom.connections').set({ status }).where('id', '=', id).execute();
    await loomAudit(trx, c.actor, `loom.connection_${act}d`, c.businessId, { targetType: 'loom_connection', targetId: id });
    return { status };
  });
}

/**
 * Human review of the first snapshot (§16). Approve only from pending_review
 * (mapping complete, synced, quality gate without blockers). The first
 * approved connection becomes the analysis source unless primary=false.
 */
export async function review(c: Ctx, id: string, input: z.infer<typeof reviewInput>) {
  return withTenant(c.businessId, async (trx) => {
    const r = await load(trx, c.businessId, id);
    if (input.decision === 'approve' && r.review_status !== 'pending_review') {
      throw Errors.conflict('review_not_ready', 'Complete the mapping and a sync whose quality review has no blockers first', { review_status: r.review_status, blockers: (r.review as { blockers?: string[] })?.blockers ?? [] });
    }
    if (input.decision === 'reject' && !['pending_review', 'approved', 'pending_mapping'].includes(r.review_status)) throw Errors.conflict('invalid_transition');
    let primary = r.primary_source;
    if (input.decision === 'approve') {
      const other = await trx.selectFrom('loom.connections').select('id').where('business_id', '=', c.businessId).where('primary_source', '=', true).where('id', '!=', id).executeTakeFirst();
      const want = input.primary ?? !other;
      if (want && other) await trx.updateTable('loom.connections').set({ primary_source: false }).where('id', '=', other.id).execute();
      primary = want || r.primary_source;
    } else primary = false;
    await trx.updateTable('loom.connections').set({ review_status: input.decision === 'approve' ? 'approved' : 'rejected', reviewed_by: c.actor.userId, reviewed_at: new Date(), primary_source: primary }).where('id', '=', id).execute();
    await loomAudit(trx, c.actor, `loom.connection_${input.decision === 'approve' ? 'approved' : 'rejected'}`, c.businessId, { targetType: 'loom_connection', targetId: id, data: { note: input.note ?? null, primary } });
    return { review_status: input.decision === 'approve' ? 'approved' : 'rejected', primary_source: primary };
  });
}

/** Suspected duplicates are only ever marked by a human; nothing is merged automatically. */
export async function decideLink(c: Ctx, id: string, input: z.infer<typeof linkDecisionInput>) {
  return withTenant(c.businessId, async (trx) => {
    await load(trx, c.businessId, id);
    const u = await trx.updateTable('loom.entity_links').set({ status: input.status }).where('business_id', '=', c.businessId).where('connection_id', '=', id).where('id', '=', input.link_id).returning('id').executeTakeFirst();
    if (!u) throw Errors.notFound('link');
    await loomAudit(trx, c.actor, 'loom.entity_link_decided', c.businessId, { targetType: 'loom_entity_link', targetId: input.link_id, data: { status: input.status } });
    return { id: input.link_id, status: input.status };
  });
}

import { z } from 'zod';
import { loomConnections, mappingSchema } from '@/loom';
import type { AuditActor } from '../infra/audit';
import { Errors } from '../http/errors';

/**
 * Shared dispatcher for the connection sub-operations, used by the tenant
 * routes (/api/v1/t/{slug}/loom/connections/{id}/{op}) and the platform routes
 * for external businesses (/api/v1/platform/loom/businesses/{b}/connections/{id}/{op}).
 * Both call the same host-agnostic Loom service with a resolved business id.
 */
export const opBody = z.record(z.string(), z.unknown());

const schemas = {
  mapping: mappingSchema,
  files: loomConnections.uploadInput,
  review: loomConnections.reviewInput,
  links: loomConnections.linkDecisionInput,
} as const;

function parse<S extends z.ZodTypeAny>(s: S, body: unknown): z.infer<S> {
  const r = s.safeParse(body);
  if (!r.success) throw Errors.validation(r.error.issues.map((i) => ({ path: i.path.join('.'), code: i.code, message: i.message })));
  return r.data;
}

export async function runConnectionOp(op: string, c: { businessId: string; actor: AuditActor; locale: 'ar' | 'en' }, id: string, body: unknown) {
  switch (op) {
    case 'mapping': return { status: 200, data: await loomConnections.putMapping(c, id, parse(schemas.mapping, body)) };
    case 'files': return { status: 201, data: await loomConnections.upload(c, id, parse(schemas.files, body)) };
    case 'review': return { status: 200, data: await loomConnections.review(c, id, parse(schemas.review, body)) };
    case 'links': return { status: 200, data: await loomConnections.decideLink(c, id, parse(schemas.links, body)) };
    default: throw Errors.notFound('operation');
  }
}

export const parseBody = parse;

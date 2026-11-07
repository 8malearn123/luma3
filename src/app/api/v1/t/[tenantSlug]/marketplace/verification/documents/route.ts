import { route } from '@/server/http/route';
import { Errors } from '@/server/http/errors';
import { DOC_KINDS, MAX_DOC_BYTES, uploadVerificationDocument, type DocKind } from '@/server/domains/marketplace';

/**
 * POST multipart/form-data { kind, file, iban? } — uploads a private
 * verification document (PDF or image; the content type is detected, not trusted).
 */
export const POST = route({
  auth: 'tenant', capability: 'business.manage',
  rateLimit: { scope: 'user', name: 'verification_upload', limit: 30, windowSec: 3600 },
  handler: async ({ tenant, actor, req }) => {
    const len = Number(req.headers.get('content-length') ?? 0);
    if (len > MAX_DOC_BYTES + 64 * 1024) throw Errors.invalid('file_too_large');
    const form = await req.formData().catch(() => { throw Errors.invalid('invalid_upload'); });
    const kind = String(form.get('kind') ?? '') as DocKind;
    if (!DOC_KINDS.includes(kind)) throw Errors.invalid('invalid_document_kind');
    const file = form.get('file');
    if (!(file instanceof Blob)) throw Errors.invalid('file_required');
    const iban = form.get('iban');
    const name = file instanceof File ? file.name.replace(/[^\p{L}\p{N} ._-]/gu, '').slice(0, 160) : null;
    return { status: 201, data: await uploadVerificationDocument(tenant, actor, { kind, data: Buffer.from(await file.arrayBuffer()), fileName: name, iban: typeof iban === 'string' ? iban : null }) };
  },
});

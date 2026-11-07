import { route } from '@/server/http/route';
import { Errors } from '@/server/http/errors';
import { requireUuidParam } from '@/server/http/params';
import { MAX_DOC_BYTES, uploadDocument } from '@/server/domains/hr/files';

/** POST multipart/form-data { file, title, expires_on? } — a PDF or an image (owner only). */
export const POST = route({
  auth: 'tenant', capability: 'staff_file.manage',
  rateLimit: { scope: 'user', name: 'upload', limit: 120, windowSec: 3600 },
  handler: async ({ tenant, actor, params, req }) => {
    const len = Number(req.headers.get('content-length') ?? 0);
    if (len > MAX_DOC_BYTES + 64 * 1024) throw Errors.invalid('file_too_large');
    const form = await req.formData().catch(() => { throw Errors.invalid('invalid_upload'); });
    const file = form.get('file');
    if (!(file instanceof Blob)) throw Errors.invalid('file_required');
    const str = (k: string) => { const v = form.get(k); return typeof v === 'string' ? v : ''; };
    const data = Buffer.from(await file.arrayBuffer());
    return { status: 201, data: await uploadDocument(tenant, actor, requireUuidParam(params, 'staffId'), { data, title: str('title'), expires_on: str('expires_on') || null }) };
  },
});

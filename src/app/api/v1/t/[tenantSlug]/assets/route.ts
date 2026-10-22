import { route } from '@/server/http/route';
import { Errors } from '@/server/http/errors';
import { MAX_UPLOAD_BYTES, uploadImage, type UploadPurpose } from '@/server/domains/assets/service';
import { requireCapability } from '@/server/tenancy/access';
import type { Capability } from '@/server/auth/capabilities';

const PURPOSE_CAPS: Record<UploadPurpose, Capability[]> = {
  logo: ['builder.edit', 'business.manage'], cover: ['builder.edit', 'business.manage'], gallery: ['builder.edit'], block: ['builder.edit'],
  service: ['catalog.edit'], product: ['catalog.edit'], staff: ['staff.edit', 'staff.edit_own_profile'],
  evidence: ['incidents.submit'], receipt: ['finance.manage'],
};

/**
 * POST multipart/form-data { file, purpose, alt_ar?, alt_en? } — the image is
 * decoded, re-encoded to WebP and stored. The client-sent type is not trusted.
 */
export const POST = route({
  auth: 'tenant',
  rateLimit: { scope: 'user', name: 'upload', limit: 120, windowSec: 3600 },
  handler: async ({ tenant, actor, req }) => {
    const len = Number(req.headers.get('content-length') ?? 0);
    if (len > MAX_UPLOAD_BYTES + 64 * 1024) throw Errors.invalid('file_too_large');
    const form = await req.formData().catch(() => { throw Errors.invalid('invalid_upload'); });
    const purpose = String(form.get('purpose') ?? '') as UploadPurpose;
    if (!(purpose in PURPOSE_CAPS)) throw Errors.invalid('invalid_purpose');
    requireCapability(tenant, PURPOSE_CAPS[purpose]);
    const file = form.get('file');
    if (!(file instanceof Blob)) throw Errors.invalid('file_required');
    const data = Buffer.from(await file.arrayBuffer());
    const alt = (k: string) => { const v = form.get(k); return typeof v === 'string' ? v.slice(0, 160) : undefined; };
    return { status: 201, data: await uploadImage(tenant, actor, { data, purpose, alt_ar: alt('alt_ar'), alt_en: alt('alt_en') }) };
  },
});

import { route } from '@/server/http/route';
import { Errors } from '@/server/http/errors';
import { cropSchema, MAX_UPLOAD_BYTES, PURPOSE_CAPS, uploadImage, type UploadPurpose } from '@/server/domains/assets/service';
import { requireCapability } from '@/server/tenancy/access';


/**
 * POST multipart/form-data { file, purpose, alt_ar?, alt_en?, crop? } (crop = JSON {x,y,width,height} from the crop editor) — the image is
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
    let crop = null;
    const rawCrop = form.get('crop');
    if (typeof rawCrop === 'string' && rawCrop) {
      let parsed: unknown;
      try { parsed = JSON.parse(rawCrop); } catch { throw Errors.invalid('invalid_crop'); }
      const c = cropSchema.safeParse(parsed);
      if (!c.success) throw Errors.invalid('invalid_crop');
      crop = c.data;
    }
    return { status: 201, data: await uploadImage(tenant, actor, { data, purpose, alt_ar: alt('alt_ar'), alt_en: alt('alt_en'), crop }) };
  },
});

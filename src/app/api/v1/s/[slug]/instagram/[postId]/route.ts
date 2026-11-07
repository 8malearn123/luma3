import { route } from '@/server/http/route';
import { Errors } from '@/server/http/errors';
import { resolvePublishedTenant } from '@/server/domains/storefront/service';
import { instagramImageUrl } from '@/server/domains/instagram/service';

const MAX_BYTES = 5 * 1024 * 1024;

/**
 * GET an Instagram post image for the storefront section. Only images of the
 * business's cached posts (official API) from Instagram media hosts are served,
 * so visitors' browsers never contact Meta and the CSP stays 'self'.
 */
export const GET = route({
  auth: 'public',
  rateLimit: { scope: 'ip', name: 'instagram_media', limit: 300, windowSec: 60 },
  handler: async ({ params }) => {
    const t = await resolvePublishedTenant(params.slug!);
    if (!t || !/^[0-9A-Za-z_]{1,64}$/.test(params.postId ?? '')) throw Errors.notFound();
    const url = await instagramImageUrl(t.id, params.postId!);
    if (!url) throw Errors.notFound();
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000), redirect: 'error' }).catch(() => null);
    const type = res?.headers.get('content-type') ?? '';
    if (!res || !res.ok || !/^image\/(jpeg|png|webp|gif)$/.test(type.split(';')[0]!.trim())) throw Errors.notFound();
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) throw Errors.notFound();
    return new Response(buf, { headers: { 'content-type': type, 'cache-control': 'public, max-age=3600', 'x-content-type-options': 'nosniff' } });
  },
});

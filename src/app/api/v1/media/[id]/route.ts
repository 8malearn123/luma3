import { sql } from 'kysely';
import { db, isUuid } from '@/server/db/client';
import { route } from '@/server/http/route';
import { Errors } from '@/server/http/errors';
import { storage } from '@/server/infra/storage';
import { resolveTenantAccess, hasCapability } from '@/server/tenancy/access';

/**
 * GET /api/v1/media/:id — streams an asset.
 * Public storefront images: cacheable, no auth. Private (evidence, receipts):
 * only members of the owning business with the right capability.
 */
export const GET = route({
  auth: 'optional',
  handler: async ({ params, user }) => {
    if (!isUuid(params.id)) throw Errors.notFound();
    const r = await sql<{ tenant_id: string | null; storage_key: string; mime: string; visibility: string; purpose: string; status: string }>`
      select * from app.asset_for_serving(${params.id})`.execute(db());
    const a = r.rows[0];
    if (!a || a.status !== 'ready') throw Errors.notFound();
    if (a.visibility !== 'public') {
      if (!user || !a.tenant_id) throw Errors.notFound();
      const m = await sql<{ slug: string }>`select tenant_slug as slug from app.memberships_for_user(${user.userId}) where tenant_id = ${a.tenant_id}`.execute(db());
      const slug = m.rows[0]?.slug;
      if (!slug) throw Errors.notFound();
      const access = await resolveTenantAccess(user, slug);
      const need = a.purpose === 'evidence' ? (['incidents.submit', 'incidents.review'] as const) : a.purpose === 'export' ? (['finance.export'] as const) : (['finance.view'] as const);
      if (!hasCapability(access, [...need])) throw Errors.notFound();
    }
    const data = await storage().get(a.storage_key);
    if (!data) throw Errors.notFound();
    return new Response(new Uint8Array(data), {
      headers: {
        'Content-Type': a.mime,
        'Content-Length': String(data.length),
        'Cache-Control': a.visibility === 'public' ? 'public, max-age=31536000, immutable' : 'private, no-store',
        'Content-Disposition': a.purpose === 'export' ? `attachment; filename="luma-export-${params.id}.csv"` : 'inline',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  },
});

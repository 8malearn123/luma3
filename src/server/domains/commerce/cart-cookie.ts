import { env } from '../../env';
import { withTenant } from '../../db/client';
import { Errors } from '../../http/errors';
import { featureEnabled, loadEntitlements } from '../../tenancy/access';
import { CART_COOKIE, type CartIdentity } from './cart';
import { resolveStorefront, type StorefrontTenant } from './storefront';

/** Reads the cart identity for a storefront request (signed-in user and/or anonymous cookie). */
export function cartIdentity(req: { cookies: { get(name: string): { value: string } | undefined } }, user: { userId: string } | null): CartIdentity {
  const raw = req.cookies.get(CART_COOKIE)?.value ?? null;
  const anonToken = raw && /^[A-Za-z0-9_-]{32,64}$/.test(raw) ? raw : null;
  return { userId: user?.userId ?? null, anonToken };
}

export function cartCookie(token: string) {
  return {
    name: CART_COOKIE, value: token,
    options: { httpOnly: true, secure: env().isProduction, sameSite: 'lax' as const, path: '/', maxAge: 60 * 60 * 24 * 30 },
  };
}

/** Live storefront whose plan includes products; otherwise the same 404. */
export async function resolveShop(slug: string): Promise<StorefrontTenant> {
  const t = await resolveStorefront(slug);
  const ent = await withTenant(t.tenantId, (trx) => loadEntitlements(trx, t.tenantId));
  if (!featureEnabled({ plan: ent }, 'feature.products')) throw Errors.notFound('shop');
  return t;
}

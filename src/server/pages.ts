import 'server-only';
import { cookies, headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { resolveSession, SESSION_COOKIE, type SessionUser } from './auth/service';
import { resolveTenantAccess, type TenantAccess } from './tenancy/access';
import { AppError } from './http/errors';

/** Session for server components (no redirect). */
export async function getSessionUser(): Promise<SessionUser | null> {
  return resolveSession((await cookies()).get(SESSION_COOKIE)?.value);
}

export async function requireUser(next?: string): Promise<SessionUser> {
  const u = await getSessionUser();
  if (!u) {
    const path = next ?? (await headers()).get('x-pathname') ?? '/';
    redirect(`/auth/login?next=${encodeURIComponent(path)}`);
  }
  return u;
}

/** Tenant access for dashboard pages; non-members get the same 404 as unknown slugs. */
export async function requireTenantPage(slug: string): Promise<{ user: SessionUser; access: TenantAccess }> {
  const user = await requireUser(`/app/${slug}`);
  try {
    return { user, access: await resolveTenantAccess(user, slug) };
  } catch (e) {
    if (e instanceof AppError && e.status === 404) notFound();
    throw e;
  }
}

/** Serializable subset passed to client components. */
export function clientAccess(a: TenantAccess) {
  return {
    tenantId: a.tenantId, slug: a.slug, name: a.name, status: a.status, businessType: a.businessType, timezone: a.timezone, currency: a.currency,
    role: a.role, staffProfileId: a.staffProfileId, capabilities: [...a.capabilities] as string[], readOnly: a.readOnly, support: a.role === 'support',
    plan: { code: a.plan.planCode, status: a.plan.subscriptionStatus, features: Object.fromEntries([...a.plan.features].map(([k, v]) => [k, v])) },
  };
}
export type ClientAccess = ReturnType<typeof clientAccess>;

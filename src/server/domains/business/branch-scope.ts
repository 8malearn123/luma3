import { withTenant, type Tx } from '../../db/client';
import { Errors } from '../../http/errors';
import type { TenantAccess } from '../../tenancy/access';

/**
 * Branch switcher scope. The workspace header lets a member pick one branch or
 * «كل الفروع»; the choice is kept per user and business in a cookie
 * (`luma_branch_<slug>`), and read APIs that hold branch data filter by it.
 * An explicit `branch_id` query parameter overrides the cookie (`all` = every
 * branch the member may see).
 *
 * Restriction: a member other than the owner whose staff profile is assigned
 * to one or more branches only ever sees those branches — a stale or forged
 * cookie falls back to her own branches, an explicit foreign branch is 403.
 * The owner, LUMA support and members without branch assignments are not restricted.
 */
export type BranchScope = {
  /** Branch ids to filter by; null = no filter (all branches). */
  branchIds: string[] | null;
  /** The single selected branch, or null for "all". */
  selected: string | null;
  /** The member is limited to `allowed`. */
  restricted: boolean;
  /** Branches the member may see; null = all. */
  allowed: string[] | null;
};

export const branchCookieName = (slug: string) => `luma_branch_${slug}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function allowedBranchIds(trx: Tx, access: TenantAccess): Promise<string[] | null> {
  if (access.role === 'owner' || access.role === 'support' || !access.staffProfileId) return null;
  const rows = await trx.selectFrom('staff_branch_assignments as a').innerJoin('branches as b', 'b.id', 'a.branch_id')
    .select('a.branch_id').where('a.staff_id', '=', access.staffProfileId).where('b.status', '=', 'active').execute();
  return rows.length ? rows.map((r) => r.branch_id) : null;
}

export async function resolveBranchScope(access: TenantAccess, req: { explicit?: string | null; cookie?: string | null }): Promise<BranchScope> {
  return withTenant(access.tenantId, async (trx) => {
    const allowed = await allowedBranchIds(trx, access);
    const restricted = allowed !== null;
    const all = (): BranchScope => ({ branchIds: allowed, selected: null, restricted, allowed });
    const explicit = req.explicit?.trim() || null;
    if (explicit) {
      if (explicit === 'all') return all();
      if (!UUID.test(explicit)) throw Errors.invalid('invalid_branch', 'Unknown branch');
      if (allowed && !allowed.includes(explicit)) throw Errors.forbidden('You can only see your own branch', { reason: 'branch_not_allowed' });
      // An unknown id simply matches nothing (RLS keeps other tenants' branches out).
      return { branchIds: [explicit], selected: explicit, restricted, allowed };
    }
    const c = req.cookie?.trim() || null;
    if (c && UUID.test(c) && (!allowed || allowed.includes(c))) {
      const b = await trx.selectFrom('branches').select('id').where('id', '=', c).where('status', '=', 'active').executeTakeFirst();
      if (b) return { branchIds: [c], selected: c, restricted, allowed };
    }
    return all();
  });
}

type ReqLike = { nextUrl: { searchParams: URLSearchParams }; cookies: { get(name: string): { value: string } | undefined } };

/** Scope for a tenant API request: `?branch_id=` then the switcher cookie. */
export function branchScopeFor(req: ReqLike, access: TenantAccess) {
  return resolveBranchScope(access, {
    explicit: req.nextUrl.searchParams.get('branch_id'),
    cookie: req.cookies.get(branchCookieName(access.slug))?.value ?? null,
  });
}

/** Staff profiles that work in any of the branches (null = no filter). */
export async function staffInBranches(trx: Tx, branchIds: string[] | null): Promise<string[] | null> {
  if (!branchIds) return null;
  if (!branchIds.length) return [];
  const rows = await trx.selectFrom('staff_branch_assignments').select('staff_id').distinct().where('branch_id', 'in', branchIds).execute();
  return rows.map((r) => r.staff_id);
}

/** Branches the switcher offers this member, with her current selection. */
export async function branchSwitcherData(access: TenantAccess, cookie: string | null) {
  const scope = await resolveBranchScope(access, { cookie });
  return withTenant(access.tenantId, async (trx) => {
    let q = trx.selectFrom('branches').select(['id', 'name', 'city', 'is_primary']).where('status', '=', 'active');
    if (scope.allowed) q = q.where('id', 'in', scope.allowed);
    const branches = await q.orderBy('is_primary', 'desc').orderBy('created_at').execute();
    return { branches, selected: scope.selected, restricted: scope.restricted, allow_all: !scope.restricted || branches.length > 1 };
  });
}

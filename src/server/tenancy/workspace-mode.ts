import { sql, withSystem } from '../db/client';
import type { Capability } from '../auth/capabilities';
import { AppError } from '../http/errors';

/**
 * Business-type workspace rules enforced on the SERVER (LUMA-AUDIT-014,
 * owner decision R5 of 2026-11-17). Hiding navigation is not authorization:
 * these rules remove capabilities when the tenant access is resolved, so every
 * API route and page that checks a capability refuses the hidden area too.
 *
 * Freelancer (business_type 'expert'):
 *  - never offers spaces for rent (hosting is a salon feature; she books spaces
 *    through «احجزي مساحة عمل», capability workspace.book, unaffected);
 *  - «مساعداتي» (team) stays available so she can add an assistant;
 *  - payroll, attendance, leave, staff files and HR requests exist only while
 *    she has ANOTHER active staff member (a staff profile not linked to the
 *    owner, or another active membership). Data is never deleted: it reappears
 *    as soon as an assistant is active again;
 *  - a solo expert works from one studio: no new branches (POST /branches) and
 *    no branches list / limit banner in the UI.
 */
export const EXPERT_HIDDEN_CAPABILITIES: readonly Capability[] = ['hosting.view', 'hosting.manage'];
export const SOLO_HIDDEN_CAPABILITIES: readonly Capability[] = [
  'payroll.view', 'payroll.manage', 'payroll.view_own', 'attendance.own', 'attendance.manage',
  'leave.request', 'leave.approve', 'hr.request', 'hr.configure', 'staff_file.manage',
];

export type WorkspaceMode = { solo: boolean };

/** True when the tenant has a working member other than its owner. */
export async function hasOtherActiveStaff(tenantId: string): Promise<boolean> {
  const r = await withSystem('workspace mode: other staff', (trx) => sql<{ other: boolean }>`
    select exists (
      select 1 from staff_profiles s
       where s.tenant_id = ${tenantId} and s.is_active and s.archived_at is null
         and not exists (select 1 from tenant_memberships m where m.tenant_id = s.tenant_id and m.staff_profile_id = s.id and m.role = 'owner' and m.status = 'active')
    ) or exists (
      select 1 from tenant_memberships m where m.tenant_id = ${tenantId} and m.status = 'active' and m.role <> 'owner'
    ) as other`.execute(trx));
  return !!r.rows[0]?.other;
}

export async function workspaceModeFor(tenantId: string, businessType: string): Promise<WorkspaceMode> {
  if (businessType !== 'expert') return { solo: false };
  return { solo: !(await hasOtherActiveStaff(tenantId)) };
}

/** Capabilities after the business-type rules (pure). */
export function restrictForWorkspace(caps: Set<Capability>, businessType: string, mode: WorkspaceMode): Set<Capability> {
  if (businessType !== 'expert') return caps;
  const out = new Set(caps);
  for (const c of EXPERT_HIDDEN_CAPABILITIES) out.delete(c);
  if (mode.solo) for (const c of SOLO_HIDDEN_CAPABILITIES) out.delete(c);
  return out;
}

/** Areas a page can ask about to show «غير متاح» instead of a permission error. */
/** 'payroll' and 'team_admin' (leave, HR requests): only with another active staff member. */
export type WorkspaceArea = 'hosting' | 'groups' | 'payroll' | 'team_admin' | 'branches_multi';
export function areaAvailable(access: { businessType: string; workspace?: WorkspaceMode }, area: WorkspaceArea): boolean {
  if (access.businessType !== 'expert') return true;
  if (area === 'hosting' || area === 'groups') return false;
  return !access.workspace?.solo;
}

/** Server guard for business-type areas that no capability expresses (new branches, group sessions). */
export function requireArea(access: { businessType: string; workspace?: WorkspaceMode }, area: WorkspaceArea) {
  if (!areaAvailable(access, area)) {
    throw new AppError(403, 'not_available', 'This feature is not available for this business type', { reason: 'business_type', area });
  }
}

import type { Capability } from '../auth/capabilities';
import type { AuditActor } from '../infra/audit';
import type { TenantAccess } from '../tenancy/access';

/**
 * Loom capability mapping in LUMA (docs/LOOM_CORE.md, docs/PERMISSIONS.md):
 *   loom.view                 → marketing.view or marketing.manage
 *   loom.manage               → marketing.manage
 *   loom.connections.manage   → business.manage (owner only)
 *   shared-training consent   → business.manage (owner only)
 * Plan feature: feature.marketing_ai.
 */
export const LOOM_VIEW: readonly Capability[] = ['marketing.view', 'marketing.manage'];
export const LOOM_MANAGE: Capability = 'marketing.manage';
export const LOOM_CONNECTIONS: Capability = 'business.manage';
export const LOOM_FEATURE = 'feature.marketing_ai' as const;

export const loomCtx = (tenant: TenantAccess, actor: AuditActor, locale: 'ar' | 'en') => ({ businessId: tenant.tenantId, actor, locale });

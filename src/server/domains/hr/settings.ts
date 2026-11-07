import { z } from 'zod';
import { withTenant } from '../../db/client';
import { audit, type AuditActor } from '../../infra/audit';
import type { TenantAccess } from '../../tenancy/access';
import { loadHrSettings } from './common';

export const hrSettingsInput = z.object({
  grace_minutes: z.number().int().min(0).max(240).optional(),
  leave_balance_policy: z.enum(['block', 'warn']).optional(),
  attendance_deductions: z.boolean().optional(),
}).strict();

export async function getHrSettings(access: TenantAccess) {
  return withTenant(access.tenantId, (trx) => loadHrSettings(trx));
}

export async function updateHrSettings(access: TenantAccess, actor: AuditActor, input: z.infer<typeof hrSettingsInput>) {
  return withTenant(access.tenantId, async (trx) => {
    const cur = await loadHrSettings(trx);
    const next = { ...cur, ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) };
    await trx.insertInto('hr_settings').values({ tenant_id: access.tenantId, ...next, updated_by: actor.userId })
      .onConflict((oc) => oc.column('tenant_id').doUpdateSet({ ...next, updated_by: actor.userId })).execute();
    await audit(trx, actor, 'hr.settings_updated', { tenantId: access.tenantId, targetType: 'tenant', targetId: access.tenantId, data: { from: cur, to: next } });
    return next;
  });
}

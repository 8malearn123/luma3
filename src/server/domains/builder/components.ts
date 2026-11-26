import type { Tx } from '../../db/client';
import { featureEnabled, type TenantAccess } from '../../tenancy/access';
import { BLOCK_TYPES, type BlockType, type PageBlock } from '@/shared/builder/blocks';
import type { PlanFeatureKey } from '@/shared/plans';
import type { PageIssue, RefWarning } from './validation';

/**
 * Platform switches for builder components (LUMA-AUDIT-019). A block type is
 * unavailable to a business when the platform disabled it (builder_components
 * .is_enabled = false) or when its `min_plan_feature` is not in the plan.
 */
export type ComponentAvailability = Record<BlockType, { available: boolean; reason: 'disabled' | 'plan' | null; feature: string | null }>;

export async function componentAvailability(trx: Tx, access: Pick<TenantAccess, 'plan'>): Promise<ComponentAvailability> {
  // builder_components is platform-wide (no tenant_id): readable inside a tenant transaction.
  const rows = await trx.selectFrom('builder_components').select(['type', 'is_enabled', 'min_plan_feature']).execute();
  const byType = new Map(rows.map((r) => [r.type, r]));
  return Object.fromEntries(BLOCK_TYPES.map((type) => {
    const r = byType.get(type);
    const feature = r?.min_plan_feature ?? null;
    if (r && !r.is_enabled) return [type, { available: false, reason: 'disabled', feature }];
    if (feature && !featureEnabled(access, feature as PlanFeatureKey)) return [type, { available: false, reason: 'plan', feature }];
    return [type, { available: true, reason: null, feature }];
  })) as ComponentAvailability;
}

function eachBlock(list: PageBlock[], fn: (b: PageBlock) => void) {
  for (const b of list) { fn(b); if (b.children) eachBlock(b.children, fn); }
}

export function blockIds(list: PageBlock[]) {
  const ids = new Set<string>();
  eachBlock(list, (b) => ids.add(`${b.type}:${b.id}`));
  return ids;
}

/**
 * Unavailable components in a page. With `existing`, only blocks that are NEW
 * (not already in the saved draft) are errors — so an owner whose page already
 * holds a now-disabled block can keep editing; publishing still requires removing it.
 */
export function componentIssues(pageId: string | null, blocks: PageBlock[], avail: ComponentAvailability, existing?: Set<string>) {
  const issues: PageIssue[] = [];
  const warnings: RefWarning[] = [];
  eachBlock(blocks, (b) => {
    const a = avail[b.type];
    if (!a || a.available) return;
    const code = a.reason === 'plan' ? 'component_plan' : 'component_disabled';
    if (existing && existing.has(`${b.type}:${b.id}`)) {
      warnings.push({ pageId, blockId: b.id, kind: 'block', targetId: b.type, code });
    } else {
      issues.push({
        pageId, blockId: b.id, path: `blocks.${b.id}`, code,
        message: a.reason === 'plan' ? `The "${b.type}" block needs a plan with ${a.feature}` : `The "${b.type}" block is currently unavailable on LUMA`,
      });
    }
  });
  return { issues, warnings };
}

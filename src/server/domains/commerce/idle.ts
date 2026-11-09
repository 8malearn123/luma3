import { sql, type RawBuilder } from 'kysely';
import { withSystem } from '../../db/client';
import { notifyCapability } from '../../infra/notify';

/**
 * Items that are not being drawn from stock. Stock leaves the shelf through a
 * sale (retail) or a service consumption (materials, via recipes); an item that
 * holds stock and had neither for IDLE_DAYS is flagged, with the likely cause:
 *  - `no_recipe`:    a material no active service recipe uses, so completed
 *                    services never deduct it (usage goes unrecorded);
 *  - `not_consumed`: a material in a recipe, but no such service was completed;
 *  - `not_sold`:     a retail item that did not sell (slow-moving stock).
 * Items younger than IDLE_DAYS are not judged yet.
 */
export const IDLE_DAYS = 30;
export type IdleReason = 'no_recipe' | 'not_consumed' | 'not_sold';

/** SQL `idle_reason` for an inventory_items row aliased `ii` (null when not idle). */
export function idleReasonSql(now: Date = new Date()): RawBuilder<IdleReason | null> {
  const since = sql`${now}::timestamptz - make_interval(days => ${IDLE_DAYS})`;
  return sql<IdleReason | null>`case
    when not ii.is_active or ii.on_hand - ii.reserved <= 0 or ii.created_at > ${since} then null
    when exists (select 1 from stock_movements sm where sm.inventory_item_id = ii.id
      and sm.kind in ('sale', 'consumption') and sm.created_at > ${since}) then null
    when ii.kind = 'retail' or ii.kind = 'both' then 'not_sold'
    when not exists (select 1 from service_material_recipes r join services s on s.id = r.service_id and s.is_active
      where r.inventory_item_id = ii.id) then 'no_recipe'
    else 'not_consumed' end`;
}

export type IdleItem = { item_id: string; tenant_id: string; slug: string; name: string; reason: IdleReason };

export async function findIdleItems(now = new Date(), tenantId?: string): Promise<IdleItem[]> {
  return withSystem('find inventory items nothing has drawn from', async (trx) => {
    const res = await sql<IdleItem>`
      select * from (
        select ii.id as item_id, ii.tenant_id, t.slug::text as slug, ii.name, ${idleReasonSql(now)} as reason
        from inventory_items ii join tenants t on t.id = ii.tenant_id
        where ii.is_active ${tenantId ? sql`and ii.tenant_id = ${tenantId}` : sql``}
      ) x where x.reason is not null
      order by x.tenant_id, x.name
      limit 5000`.execute(trx);
    return res.rows;
  });
}

const REASON_AR: Record<IdleReason, string> = {
  no_recipe: 'غير مرتبطة بوصفة خدمة فلا تُخصم عند إكمال الخدمات',
  not_consumed: 'لم تُستهلك في أي خدمة مكتملة',
  not_sold: 'لم يُبع منها شيء',
};
const REASON_EN: Record<IdleReason, string> = {
  no_recipe: 'not in any service recipe, so completed services never deduct it',
  not_consumed: 'not consumed by any completed service',
  not_sold: 'nothing sold',
};

/** One digest per tenant per week (dedupe key carries the ISO week). */
export async function runIdleStockCheck(now = new Date()) {
  const items = await findIdleItems(now);
  const byTenant = new Map<string, IdleItem[]>();
  for (const i of items) byTenant.set(i.tenant_id, [...(byTenant.get(i.tenant_id) ?? []), i]);
  const week = isoWeek(now);
  for (const [tenantId, list] of byTenant) {
    const sample = list.slice(0, 3);
    const more = list.length - sample.length;
    await withSystem('notify about items not drawn from stock', (trx) => notifyCapability(trx, tenantId, ['inventory.manage'], {
      kind: 'inventory.idle_stock',
      title_ar: `${list.length} من الأصناف لا تُسحب من المخزون منذ ${IDLE_DAYS} يومًا`,
      title_en: `${list.length} item(s) not drawn from stock in ${IDLE_DAYS} days`,
      body_ar: sample.map((i) => `${i.name}: ${REASON_AR[i.reason]}`).join('، ') + (more > 0 ? `، و${more} غيرها.` : '.'),
      body_en: sample.map((i) => `${i.name}: ${REASON_EN[i.reason]}`).join('; ') + (more > 0 ? `; and ${more} more.` : '.'),
      target_path: `/app/${list[0]!.slug}/inventory?idle=1`,
      data: { count: list.length, items: list.slice(0, 50).map((i) => ({ id: i.item_id, reason: i.reason })) },
      dedupe_key: `stock_idle:${tenantId}:${week}`,
    }));
  }
  return { tenants: byTenant.size, items: items.length };
}

function isoWeek(d: Date) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  return `${t.getUTCFullYear()}-W${String(Math.ceil(((t.getTime() - yearStart) / 86_400_000 + 1) / 7)).padStart(2, '0')}`;
}

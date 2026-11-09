import type { Tx } from '../../db/client';
import type { PageBlock } from '@/shared/builder/blocks';
import type { PublicEvents, PublicInstagram, PublicPortfolioItem } from '@/shared/builder/storefront';
import { loadPublicPortfolio } from './service';
import { loadPublicInstagram } from '../instagram/service';
import { publicEventInfo } from '../events/service';

/**
 * Storefront extras for the expert experience (portfolio, Instagram, events),
 * loaded only when a page uses the matching block so other storefronts pay
 * nothing. Returns the extra asset ids the renderer needs metadata for.
 */
export async function loadStorefrontExtras(trx: Tx, tenantId: string, blocks: PageBlock[], opts: { all?: boolean } = {}): Promise<{
  assetIds: string[]; data: { portfolio?: PublicPortfolioItem[]; instagram?: PublicInstagram; events?: PublicEvents };
}> {
  const types = new Set<string>();
  const assetIds: string[] = [];
  let portfolio = false;
  const visit = (b: PageBlock) => {
    types.add(b.type);
    if (b.type === 'before_after') {
      const p = b.props as { source?: string; items?: Array<{ before_asset_id?: string; after_asset_id?: string }> };
      if (p.source === 'portfolio') portfolio = true;
      for (const i of p.items ?? []) { if (i.before_asset_id) assetIds.push(i.before_asset_id); if (i.after_asset_id) assetIds.push(i.after_asset_id); }
    }
    b.children?.forEach(visit);
  };
  blocks.forEach(visit);
  const data: { portfolio?: PublicPortfolioItem[]; instagram?: PublicInstagram; events?: PublicEvents } = {};
  // The builder canvas loads everything so switching a block's source shows data at once.
  if (portfolio || opts.all) {
    data.portfolio = await loadPublicPortfolio(trx, tenantId);
    for (const i of data.portfolio) { if (i.before_asset_id) assetIds.push(i.before_asset_id); assetIds.push(i.after_asset_id); }
  }
  if (types.has('instagram') || opts.all) data.instagram = await loadPublicInstagram(trx, tenantId);
  // The event request entry is cheap and also used by the storefront event pages.
  data.events = await publicEventInfo(trx, tenantId);
  return { assetIds, data };
}

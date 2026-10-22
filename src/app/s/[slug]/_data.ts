import 'server-only';
import { cache } from 'react';
import { notFound } from 'next/navigation';
import { getLocale } from '@/i18n/server';
import { getPublishedStorefront } from '@/server/domains/storefront/service';
import type { RenderCtx } from '@/ui/storefront/context';

/** One read-model load per request, shared by the layout and the page. Unpublished/unknown → 404. */
export const loadStorefront = cache(async (slug: string) => getPublishedStorefront(slug));

export async function storefrontCtx(slug: string): Promise<RenderCtx> {
  const data = await loadStorefront(slug);
  if (!data) notFound();
  return { data, locale: await getLocale() };
}

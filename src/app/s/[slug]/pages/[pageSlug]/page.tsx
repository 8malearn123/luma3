import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { storefrontCtx } from '../../_data';
import { PageView } from '@/ui/storefront/views';
import { TrackView } from '@/ui/storefront/TrackView';
import { hrefPage, pk } from '@/ui/storefront/context';

export async function generateMetadata({ params }: { params: Promise<{ slug: string; pageSlug: string }> }): Promise<Metadata> {
  const { slug, pageSlug } = await params;
  const ctx = await storefrontCtx(slug);
  const p = ctx.data.pages.find((x) => x.slug === pageSlug);
  return p ? { title: pk(ctx, p.title_ar, p.title_en) } : { title: 'Not found' };
}

/** Stable linkable route for every published page (custom pages, FAQ, privacy, returns, booking policy). */
export default async function StorefrontPage({ params }: { params: Promise<{ slug: string; pageSlug: string }> }) {
  const { slug, pageSlug } = await params;
  const ctx = await storefrontCtx(slug);
  const page = ctx.data.pages.find((p) => p.slug === pageSlug);
  if (!page) notFound();
  // Fixed pages have their own routes; keep one canonical URL.
  if (['home', 'about', 'services', 'products', 'team', 'contact'].includes(page.kind)) redirect(hrefPage(ctx, page));
  return <><PageView ctx={ctx} page={page} /><TrackView slug={slug} type="page_view" /></>;
}

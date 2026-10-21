import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { storefrontCtx, loadStorefront } from '../_data';
import { PageView } from '@/ui/storefront/views';
import { TrackView } from '@/ui/storefront/TrackView';
import { pageByKind, pk } from '@/ui/storefront/context';
import { getLocale } from '@/i18n/server';

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const data = await loadStorefront((await params).slug);
  const p = data?.pages.find((x) => x.kind === 'team');
  return { title: p ? pk({ data: data!, locale: await getLocale() }, p.title_ar, p.title_en) : 'Team' };
}

export default async function StorefrontTeamPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await storefrontCtx(slug);
  const page = pageByKind(ctx, 'team');
  if (!page) notFound();
  return <><PageView ctx={ctx} page={page} /><TrackView slug={slug} type="page_view" /></>;
}

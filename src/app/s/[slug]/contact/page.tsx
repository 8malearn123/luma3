import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { storefrontCtx, loadStorefront } from '../_data';
import { PageView } from '@/ui/storefront/views';
import { TrackView } from '@/ui/storefront/TrackView';
import { pageByKind, pk } from '@/ui/storefront/context';
import { getLocale } from '@/i18n/server';

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const data = await loadStorefront((await params).slug);
  const p = data?.pages.find((x) => x.kind === 'contact');
  return { title: p ? pk({ data: data!, locale: await getLocale() }, p.title_ar, p.title_en) : 'Contact' };
}

export default async function StorefrontContactPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await storefrontCtx(slug);
  const page = pageByKind(ctx, 'contact');
  if (!page) notFound();
  return <><PageView ctx={ctx} page={page} /><TrackView slug={slug} type="page_view" /></>;
}

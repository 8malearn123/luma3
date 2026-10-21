import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { storefrontCtx } from '../_data';
import { PageView, ServicesIndex } from '@/ui/storefront/views';
import { TrackView } from '@/ui/storefront/TrackView';
import { pageByKind, tr } from '@/ui/storefront/context';

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const ctx = await storefrontCtx((await params).slug);
  return { title: tr(ctx, 'services') };
}

export default async function StorefrontServices({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ category?: string }> }) {
  const { slug } = await params;
  const { category } = await searchParams;
  const ctx = await storefrontCtx(slug);
  const page = pageByKind(ctx, 'services');
  if (!page) notFound();
  // Hidden/archived categories are not public: the filter then shows an empty, explained state.
  return <>{typeof category === 'string' && /^[0-9a-f-]{36}$/.test(category) ? <ServicesIndex ctx={ctx} categoryId={category} /> : <PageView ctx={ctx} page={page} />}<TrackView slug={slug} type="page_view" /></>;
}

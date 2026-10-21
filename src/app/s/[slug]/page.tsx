import { storefrontCtx } from './_data';
import { PageView } from '@/ui/storefront/views';
import { TrackView } from '@/ui/storefront/TrackView';
import { pageByKind } from '@/ui/storefront/context';
import { notFound } from 'next/navigation';

export default async function StorefrontHome({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await storefrontCtx(slug);
  const page = pageByKind(ctx, 'home');
  if (!page) notFound();
  return <><PageView ctx={ctx} page={page} /><TrackView slug={slug} type="page_view" /></>;
}

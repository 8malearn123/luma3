import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { storefrontCtx } from '../../_data';
import { ProductDetail } from '@/ui/storefront/views';
import { TrackView } from '@/ui/storefront/TrackView';
import { pk, productById } from '@/ui/storefront/context';

export async function generateMetadata({ params }: { params: Promise<{ slug: string; id: string }> }): Promise<Metadata> {
  const { slug, id } = await params;
  const ctx = await storefrontCtx(slug);
  const p = productById(ctx, id);
  return p ? { title: pk(ctx, p.name_ar, p.name_en) } : { title: 'Not found' };
}

export default async function StorefrontProduct({ params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params;
  const ctx = await storefrontCtx(slug);
  if (!ctx.data.features.products || !productById(ctx, id)) notFound();
  return <><ProductDetail ctx={ctx} id={id} /><TrackView slug={slug} type="product_view" entityId={id} /></>;
}

import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { storefrontCtx } from '../../_data';
import { ServiceDetail } from '@/ui/storefront/views';
import { TrackView } from '@/ui/storefront/TrackView';
import { pk, serviceById } from '@/ui/storefront/context';

export async function generateMetadata({ params }: { params: Promise<{ slug: string; id: string }> }): Promise<Metadata> {
  const { slug, id } = await params;
  const ctx = await storefrontCtx(slug);
  const s = serviceById(ctx, id);
  return s ? { title: pk(ctx, s.name_ar, s.name_en), description: pk(ctx, s.description_ar, s.description_en).slice(0, 160) || undefined } : { title: 'Not found' };
}

/** Hidden/archived/unknown services are not public (404 with a link back to services). */
export default async function StorefrontService({ params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params;
  const ctx = await storefrontCtx(slug);
  if (!serviceById(ctx, id)) notFound();
  return <><ServiceDetail ctx={ctx} id={id} /><TrackView slug={slug} type="service_view" entityId={id} /></>;
}

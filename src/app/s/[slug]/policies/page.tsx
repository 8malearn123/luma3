import type { Metadata } from 'next';
import { storefrontCtx } from '../_data';
import { PoliciesView } from '@/ui/storefront/views';
import { TrackView } from '@/ui/storefront/TrackView';
import { tr } from '@/ui/storefront/context';

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const ctx = await storefrontCtx((await params).slug);
  return { title: tr(ctx, 'policies') };
}

/** Booking, cancellation and payment terms — reachable before any payment. */
export default async function StorefrontPolicies({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await storefrontCtx(slug);
  return <><PoliciesView ctx={ctx} /><TrackView slug={slug} type="page_view" /></>;
}

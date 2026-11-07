import { requireUser } from '@/server/pages';
import { GiftPurchaseStatus } from '@/ui/storefront/OnlinePurchase';

export const dynamic = 'force-dynamic';
export const metadata = { robots: { index: false } };

/** Return page after the hosted checkout: shows the SERVER state (the redirect itself is never proof of payment). */
export default async function Page({ params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params;
  await requireUser(`/s/${slug}/gift-cards/purchase/${id}`);
  return <GiftPurchaseStatus slug={slug} id={id} />;
}

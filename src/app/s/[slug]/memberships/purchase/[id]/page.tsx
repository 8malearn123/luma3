import { requireUser } from '@/server/pages';
import { MembershipPurchaseStatus } from '@/ui/storefront/OnlinePurchase';

export const dynamic = 'force-dynamic';
export const metadata = { robots: { index: false } };

/** Return page after the hosted checkout for an online membership purchase (server state only). */
export default async function Page({ params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params;
  await requireUser(`/s/${slug}/memberships/purchase/${id}`);
  return <MembershipPurchaseStatus slug={slug} id={id} />;
}

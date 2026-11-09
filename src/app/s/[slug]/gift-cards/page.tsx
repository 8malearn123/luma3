import { notFound } from 'next/navigation';
import { publicTenant, requirePublicFeature } from '@/server/domains/storefront-public';
import { getSessionUser } from '@/server/pages';
import { AppError } from '@/server/http/errors';
import { GiftCardPurchaseForm } from '@/ui/storefront/OnlinePurchase';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Gift cards' };

/** Online gift card purchase with direct send to the recipient at a chosen time. */
export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  let tenant;
  try {
    tenant = await publicTenant(slug);
    await requirePublicFeature(tenant.id, 'feature.gift_cards');
  } catch (e) { if (e instanceof AppError) notFound(); throw e; }
  const user = await getSessionUser().catch(() => null);
  return <GiftCardPurchaseForm slug={slug} tenantName={tenant.name} signedIn={!!user} verified={!!user && (user.emailVerified || user.phoneVerified)} />;
}

import { notFound } from 'next/navigation';
import { requireUser } from '@/server/pages';
import { publicTenant, requirePublicFeature } from '@/server/domains/storefront-public';
import { AppError } from '@/server/http/errors';
import { BookingCheckout } from '@/ui/booking/BookingCheckout';

export const dynamic = 'force-dynamic';
export const metadata = { robots: { index: false } };

export default async function CheckoutPage({ params, searchParams }: { params: Promise<{ slug: string; id: string }>; searchParams: Promise<{ payment?: string }> }) {
  const { slug, id } = await params;
  const { payment } = await searchParams;
  await requireUser(`/s/${slug}/checkout/booking/${id}`);
  let tenant;
  try { tenant = await publicTenant(slug); } catch (e) { if (e instanceof AppError) notFound(); throw e; }
  const has = async (f: Parameters<typeof requirePublicFeature>[1]) => requirePublicFeature(tenant.id, f).then(() => true, () => false);
  return <BookingCheckout slug={slug} bookingId={id} timezone={tenant.timezone} returningPaymentId={payment ?? null} giftCards={await has('feature.gift_cards')} memberships={await has('feature.memberships')} />;
}

import { notFound } from 'next/navigation';
import { requireUser } from '@/server/pages';
import { resolveStorefront } from '@/server/domains/commerce';
import { AppError } from '@/server/http/errors';
import { OrderCheckout } from '@/ui/booking/OrderCheckout';

export const dynamic = 'force-dynamic';
export const metadata = { robots: { index: false } };

export default async function OrderCheckoutPage({ params, searchParams }: { params: Promise<{ slug: string; id: string }>; searchParams: Promise<{ payment?: string }> }) {
  const { slug, id } = await params;
  const { payment } = await searchParams;
  await requireUser(`/s/${slug}/checkout/order/${id}`);
  try { await resolveStorefront(slug); } catch (e) { if (e instanceof AppError) notFound(); throw e; }
  return <OrderCheckout slug={slug} orderId={id} returningPaymentId={payment ?? null} />;
}

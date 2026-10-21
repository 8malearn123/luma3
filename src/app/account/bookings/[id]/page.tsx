import { notFound } from 'next/navigation';
import { isUuid } from '@/server/db/client';
import { BookingDetail } from '@/ui/account/BookingDetail';

export const metadata = { title: 'Booking details' };

/** The customer's own booking (the layout already requires a signed-in user; the API returns 404 for anyone else's). */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  return <BookingDetail id={id} />;
}

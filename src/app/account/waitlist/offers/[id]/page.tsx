import { notFound } from 'next/navigation';
import { isUuid } from '@/server/db/client';
import { WaitlistOffer } from '@/ui/account/WaitlistOffer';

export const metadata = { title: 'Waitlist offer' };

/** Target of the waitlist.offer notification. Only the customer who received the offer can see it. */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  return <WaitlistOffer id={id} />;
}

import { notFound, redirect } from 'next/navigation';
import { isUuid } from '@/server/db/client';

/** Offers notified before the route moved pointed at /account/waitlist/:id; keep those links working. */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  redirect(`/account/waitlist/offers/${id}`);
}

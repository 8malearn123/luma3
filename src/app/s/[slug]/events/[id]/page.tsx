import { notFound } from 'next/navigation';
import { requireUser } from '@/server/pages';
import { EventDetailView } from '@/ui/storefront/EventViews';
import { loadStorefront } from '../../_data';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Event booking', robots: { index: false } };

/** The customer's event request: quote, deposit payment, cancellation. */
export default async function Page({ params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params;
  await requireUser(`/s/${slug}/events/${id}`);
  if (!(await loadStorefront(slug)) || !/^[0-9a-f-]{36}$/i.test(id)) notFound();
  return <EventDetailView slug={slug} id={id} />;
}

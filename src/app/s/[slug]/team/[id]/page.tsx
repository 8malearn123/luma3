import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { storefrontCtx } from '../../_data';
import { StaffProfile } from '@/ui/storefront/views';
import { TrackView } from '@/ui/storefront/TrackView';
import { pk, staffById } from '@/ui/storefront/context';

export async function generateMetadata({ params }: { params: Promise<{ slug: string; id: string }> }): Promise<Metadata> {
  const { slug, id } = await params;
  const ctx = await storefrontCtx(slug);
  const s = staffById(ctx, id);
  return s ? { title: pk(ctx, s.display_name, s.display_name_en) } : { title: 'Not found' };
}

/** Specialist profile; its Book button preselects her: /s/{slug}/booking?staff={id}. */
export default async function StorefrontStaff({ params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params;
  const ctx = await storefrontCtx(slug);
  if (!staffById(ctx, id)) notFound();
  return <><StaffProfile ctx={ctx} id={id} /><TrackView slug={slug} type="page_view" /></>;
}

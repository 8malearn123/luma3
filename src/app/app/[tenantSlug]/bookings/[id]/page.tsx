import { redirect } from 'next/navigation';
import { requireTenantPage } from '@/server/pages';

/** Notification links use /bookings/:id; the detail lives in the list's drawer (?booking=:id). */
export default async function Page({ params }: { params: Promise<{ tenantSlug: string; id: string }> }) {
  const { tenantSlug, id } = await params;
  await requireTenantPage(tenantSlug);
  redirect(`/app/${encodeURIComponent(tenantSlug)}/bookings?booking=${encodeURIComponent(id)}`);
}

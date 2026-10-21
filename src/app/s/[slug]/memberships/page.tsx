import { notFound } from 'next/navigation';
import { withTenant } from '@/server/db/client';
import { publicTenant, requirePublicFeature } from '@/server/domains/storefront-public';
import { listPlans } from '@/server/domains/memberships/service';
import { AppError } from '@/server/http/errors';
import { MembershipPlansList } from '@/ui/storefront/EngagementViews';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Memberships' };

/** Public, active and visible membership plans with the names of included (visible) services. */
export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  let tenant;
  try {
    tenant = await publicTenant(slug);
    await requirePublicFeature(tenant.id, 'feature.memberships');
  } catch (e) { if (e instanceof AppError) notFound(); throw e; }
  const plans = await listPlans(tenant.id, true);
  const ids = [...new Set(plans.flatMap((p) => p.items.map((i) => i.service_id)))];
  const names = ids.length ? await withTenant(tenant.id, (trx) => trx.selectFrom('services').select(['id', 'name_ar', 'name_en']).where('id', 'in', ids).where('is_visible', '=', true).where('archived_at', 'is', null).execute()) : [];
  const view = plans.map((p) => ({
    id: p.id, name_ar: p.name_ar, name_en: p.name_en, description_ar: p.description_ar, description_en: p.description_en, price_minor: p.price_minor, validity_days: p.validity_days,
    items: p.items.flatMap((i) => { const s = names.find((n) => n.id === i.service_id); return s ? [{ service_id: i.service_id, sessions: i.sessions, name_ar: s.name_ar, name_en: s.name_en }] : []; }),
  }));
  return <MembershipPlansList plans={view} currency={tenant.currency ?? 'SAR'} tenantName={tenant.name} />;
}

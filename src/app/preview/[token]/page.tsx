import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getLocale } from '@/i18n/server';
import { getPreviewStorefront } from '@/server/domains/storefront/service';
import { StorefrontShell } from '@/ui/storefront/StorefrontShell';
import { fontHref } from '@/ui/storefront/theme';
import { pageByKind, productById, serviceById, staffById, type RenderCtx } from '@/ui/storefront/context';
import { PageView, PoliciesView, ProductDetail, ProductsIndex, ServiceDetail, ServicesIndex, StaffProfile, StorefrontNotFound } from '@/ui/storefront/views';

// Drafts are never indexed (X-Robots-Tag is also set for /preview/* in next.config).
export const metadata: Metadata = { title: 'Preview', robots: { index: false, follow: false, nocache: true } };

type SP = { page?: string; service?: string; product?: string; staff?: string; category?: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function Body({ ctx, sp }: { ctx: RenderCtx; sp: SP }) {
  if (sp.service) return UUID.test(sp.service) && serviceById(ctx, sp.service) ? <ServiceDetail ctx={ctx} id={sp.service} /> : <StorefrontNotFound ctx={ctx} />;
  if (sp.product) return UUID.test(sp.product) && productById(ctx, sp.product) ? <ProductDetail ctx={ctx} id={sp.product} /> : <StorefrontNotFound ctx={ctx} />;
  if (sp.staff) return UUID.test(sp.staff) && staffById(ctx, sp.staff) ? <StaffProfile ctx={ctx} id={sp.staff} /> : <StorefrontNotFound ctx={ctx} />;
  if (sp.page === 'policies') return <PoliciesView ctx={ctx} />;
  if (sp.page === 'services' && sp.category && UUID.test(sp.category)) return <ServicesIndex ctx={ctx} categoryId={sp.category} />;
  if (sp.page === 'products' && sp.category && UUID.test(sp.category)) return <ProductsIndex ctx={ctx} categoryId={sp.category} />;
  const page = sp.page ? ctx.data.pages.find((p) => p.slug === sp.page) : pageByKind(ctx, 'home');
  return page ? <PageView ctx={ctx} page={page} /> : <StorefrontNotFound ctx={ctx} />;
}

/**
 * Draft preview behind a temporary token (or revoked/expired → 404). Renders
 * the same components as the public storefront; booking/cart are disabled and
 * no analytics are recorded.
 */
export default async function PreviewPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<SP> }) {
  const { token } = await params;
  const data = await getPreviewStorefront(token);
  if (!data) notFound();
  const ctx: RenderCtx = { data, locale: await getLocale() };
  const sp = await searchParams;
  return (
    <>
      <link rel="stylesheet" href={fontHref(data.brand)} precedence="default" />
      <StorefrontShell ctx={ctx}><Body ctx={ctx} sp={sp} /></StorefrontShell>
    </>
  );
}

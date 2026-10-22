import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { getLocale } from '@/i18n/server';
import { StorefrontShell } from '@/ui/storefront/StorefrontShell';
import { fontHref } from '@/ui/storefront/theme';
import { pk } from '@/ui/storefront/context';
import { loadStorefront } from './_data';

type Props = { children: React.ReactNode; params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const data = await loadStorefront(slug);
  if (!data) return { title: 'Not found', robots: { index: false } };
  const locale = await getLocale();
  const tagline = locale === 'ar' ? data.brand.tagline_ar || data.brand.tagline_en : data.brand.tagline_en || data.brand.tagline_ar;
  return {
    title: { default: data.tenant.name, template: `%s · ${data.tenant.name}` },
    description: tagline ?? undefined,
    robots: { index: true, follow: true },
    icons: data.brand.logo_asset_id ? { icon: `/api/v1/media/${data.brand.logo_asset_id}` } : undefined,
    openGraph: { title: data.tenant.name, description: tagline ?? undefined, siteName: data.tenant.name },
  };
}

/** Public storefront shell: the business's theme, fonts, navigation, booking entry and footer. */
export default async function StorefrontLayout({ children, params }: Props) {
  const { slug } = await params;
  const data = await loadStorefront(slug);
  if (!data) notFound();
  const locale = await getLocale();
  const path = (await headers()).get('x-pathname') ?? '';
  const seg = path.split('?')[0]!.split('/')[3] ?? '';
  const active = ['services', 'products', 'team', 'about', 'contact'].includes(seg) ? seg : seg === 'pages' ? (data.pages.find((p) => p.slug === path.split('/')[4])?.kind ?? '') : seg === '' ? 'home' : '';
  void pk;
  return (
    <>
      <link rel="stylesheet" href={fontHref(data.brand)} precedence="default" />
      <StorefrontShell ctx={{ data, locale }} activePath={active}>{children}</StorefrontShell>
    </>
  );
}

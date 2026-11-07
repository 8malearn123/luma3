import Link from 'next/link';
import { getT } from '@/i18n/server';
import { LumaLogo, LumaMark } from '@/ui/components/brand';

export const metadata = { title: '404', robots: { index: false } };

/**
 * Root 404 in the LUMA identity (plum). Used for unmatched URLs and for
 * notFound() outside segments that have their own not-found (the storefront
 * keeps the business's theme with src/app/s/[slug]/not-found.tsx).
 */
export default async function NotFound() {
  const { t } = await getT();
  return (
    <main id="main" className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden bg-luma-50 px-4 py-16 text-center">
      <LumaMark className="pointer-events-none absolute -end-24 -top-24 size-96 opacity-[0.06]" title="" />
      <Link href="/" aria-label="LUMA" className="mb-10"><LumaLogo className="h-12 w-auto" /></Link>
      <p className="font-display text-7xl tracking-widest text-luma-700 sm:text-8xl" dir="ltr" aria-hidden>404</p>
      <h1 className="mt-4 font-display text-2xl text-luma-900">{t('customer.not_found.title')}</h1>
      <p className="mt-2 max-w-md text-sm text-ink-muted">{t('customer.not_found.body')}</p>
      <div className="mt-8 flex flex-wrap justify-center gap-3">
        <Link href="/" className="inline-flex h-11 items-center rounded-full bg-luma-700 px-6 text-sm font-semibold text-white hover:bg-luma-800">{t('customer.not_found.home')}</Link>
        <Link href="/account/bookings" className="inline-flex h-11 items-center rounded-full border border-luma-300 bg-white px-6 text-sm font-semibold text-luma-800 hover:bg-luma-100">{t('customer.not_found.bookings')}</Link>
      </div>
      <p className="mt-10 text-xs text-ink-muted" dir="ltr">LUMA — Your Beauty, Our Expertise</p>
    </main>
  );
}

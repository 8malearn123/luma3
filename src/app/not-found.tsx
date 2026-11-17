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
    <main id="main" className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden bg-surface-muted px-4 py-16 text-center">
      <LumaMark className="pointer-events-none absolute -end-24 -top-24 size-96 opacity-[0.06]" title="" />
      <Link href="/" aria-label="LUMA" className="mb-10"><LumaLogo className="h-12 w-auto" /></Link>
      <p className="font-display text-7xl tracking-widest text-link sm:text-8xl" dir="ltr" aria-hidden>404</p>
      <h1 className="mt-4 font-display text-2xl text-heading">{t('customer.not_found.title')}</h1>
      <p className="mt-2 max-w-md text-sm text-ink-muted">{t('customer.not_found.body')}</p>
      <div className="mt-8 flex flex-wrap justify-center gap-3">
        <Link href="/" className="inline-flex h-11 items-center rounded-full bg-primary px-6 text-sm font-semibold text-on-primary hover:bg-primary-hover">{t('customer.not_found.home')}</Link>
        <Link href="/account/bookings" className="inline-flex h-11 items-center rounded-full border border-line-strong bg-surface px-6 text-sm font-semibold text-heading hover:bg-accent-soft">{t('customer.not_found.bookings')}</Link>
      </div>
      <p className="mt-10 text-xs text-ink-muted" dir="ltr">LUMA — Your Beauty, Our Expertise</p>
    </main>
  );
}

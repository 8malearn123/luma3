import Link from 'next/link';
import { getT } from '@/i18n/server';
import { getSessionUser } from '@/server/pages';
import { LumaLogo } from '../components/brand';
import { LocaleToggle } from './LocaleToggle';

export async function SiteHeader() {
  const { t } = await getT();
  const user = await getSessionUser().catch(() => null);
  return (
    <header className="sticky top-0 z-30 border-b border-highlight/60 bg-surface-muted/90 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center gap-4 px-4 py-3">
        <Link href="/" aria-label="LUMA"><LumaLogo className="h-9 w-auto" /></Link>
        <nav className="hidden flex-1 items-center gap-5 text-sm sm:flex">
          <Link href="/pricing" className="hover:text-link">{t('site.nav_pricing')}</Link>
          <Link href="/discover" className="hover:text-link">{t('site.nav_discover')}</Link>
        </nav>
        <div className="ms-auto flex items-center gap-2">
          <Link href="/discover" className="px-1 text-sm hover:text-link sm:hidden">{t('site.nav_discover')}</Link>
          <LocaleToggle />
          {user ? <Link href="/app" className="rounded-lg bg-primary px-3 py-1.5 text-sm text-on-primary">{t('site.nav_dashboard')}</Link> : <>
            <Link href="/auth/login" className="px-2 text-sm">{t('site.nav_login')}</Link>
            <Link href="/auth/register" className="rounded-lg bg-primary px-3 py-1.5 text-sm text-on-primary">{t('site.nav_start')}</Link>
          </>}
        </div>
      </div>
    </header>
  );
}

export async function SiteFooter() {
  const { t } = await getT();
  return (
    <footer className="mt-16 bg-primary text-accent-soft">
      <div className="luma-pattern">
        <div className="mx-auto flex max-w-6xl flex-col items-center gap-3 px-4 py-10 text-center">
          <LumaLogo white className="h-10 w-auto" />
          <p className="font-serif text-lg" dir="ltr">Your Beauty, Our Expertise.</p>
          <p className="text-xs opacity-80">{t('site.footer_privacy')}</p>
        </div>
      </div>
    </footer>
  );
}

import Link from 'next/link';
import { Wrench } from 'lucide-react';
import { getT } from '@/i18n/server';
import { LumaLogo } from '../components/brand';

/** Shown instead of the business dashboard while platform maintenance mode is on (storefronts keep working). */
export async function MaintenanceScreen({ messageAr, messageEn, slug }: { messageAr: string; messageEn: string; slug: string }) {
  const { t, locale } = await getT();
  return (
    <main className="luma-app flex min-h-dvh flex-col items-center justify-center gap-4 bg-surface-muted p-6 text-center">
      <LumaLogo className="h-9 w-auto" />
      <div className="max-w-md rounded-2xl bg-surface p-8 shadow-sm">
        <Wrench className="mx-auto mb-3 size-10 text-link" aria-hidden />
        <h1 className="text-xl font-semibold text-heading">{t('maintenance.title')}</h1>
        <p className="mt-2 text-ink-muted">{locale === 'ar' ? messageAr || messageEn : messageEn || messageAr}</p>
        <p className="mt-3 text-sm text-ok">{t('maintenance.storefront_ok')}</p>
        <div className="mt-5 flex justify-center gap-3 text-sm">
          <Link href={`/app/${slug}`} className="rounded-xl bg-primary px-4 py-2 text-on-primary">{t('maintenance.retry')}</Link>
          <Link href={`/s/${slug}`} className="rounded-xl border border-line px-4 py-2">{t('nav.storefront')}</Link>
        </div>
      </div>
    </main>
  );
}

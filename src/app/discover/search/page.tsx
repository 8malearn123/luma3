import Link from 'next/link';
import { Suspense } from 'react';
import { getT } from '@/i18n/server';
import { getSessionUser } from '@/server/pages';
import { LoadingState } from '@/ui/components/feedback';
import { MarketSearch } from '@/ui/market/MarketSearch';

export const metadata = { title: 'البحث' };
export const dynamic = 'force-dynamic';

export default async function Page() {
  const { t } = await getT();
  const user = await getSessionUser().catch(() => null);
  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <nav aria-label={t('market.breadcrumb')} className="mb-2 text-sm"><Link href="/discover" className="text-luma-700 hover:underline">{t('market.name')}</Link></nav>
      <h1 className="text-2xl font-semibold text-luma-900 md:text-3xl">{t('market.pages.search.title')}</h1>
      <p className="mb-6 mt-1 text-sm text-ink-muted">{t('market.pages.search.subtitle')}</p>
      <Suspense fallback={<LoadingState rows={4} />}>
        <MarketSearch signedIn={!!user} />
      </Suspense>
    </div>
  );
}

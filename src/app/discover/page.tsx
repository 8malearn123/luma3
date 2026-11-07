import Link from 'next/link';
import { ArrowLeft, Search, Sparkles, Store, UserRound } from 'lucide-react';
import { getT } from '@/i18n/server';
import { getSessionUser } from '@/server/pages';
import { favoriteIds, marketplaceHighlights } from '@/server/domains/marketplace/directory';
import { CardGrid } from '@/ui/market/BusinessCard';

export const metadata = { title: 'اكتشفي' };
export const dynamic = 'force-dynamic';

/** Hub: search, the two doors (salons / independent experts) and top-rated highlights. */
export default async function DiscoverHub() {
  const { t, locale } = await getT();
  const user = await getSessionUser().catch(() => null);
  const h = await marketplaceHighlights(8, await favoriteIds(user?.userId));
  const arrow = locale === 'ar' ? 'rotate-0' : 'rotate-180';
  const doors = [
    { key: 'salons', href: '/discover/salons', Icon: Store, n: h.counts.salons },
    { key: 'experts', href: '/discover/experts', Icon: UserRound, n: h.counts.experts },
  ] as const;
  return (
    <>
      <section className="relative overflow-hidden bg-gradient-to-b from-luma-100 via-luma-200/70 to-luma-50">
        <div className="luma-pattern absolute inset-0 opacity-60" aria-hidden />
        <div className="relative mx-auto max-w-6xl px-4 py-14 text-center md:py-20">
          <p className="inline-flex items-center gap-1.5 rounded-full bg-white/70 px-3 py-1 text-xs font-medium text-luma-800"><Sparkles className="size-3.5" aria-hidden />{t('market.hub.kicker')}</p>
          <h1 className="mx-auto mt-4 max-w-2xl text-3xl font-semibold leading-tight text-luma-900 md:text-5xl">{t('market.hub.title')}</h1>
          <p className="mx-auto mt-3 max-w-xl text-luma-900/75">{t('market.hub.subtitle')}</p>
          <form action="/discover/search" method="get" role="search" className="mx-auto mt-8 flex max-w-2xl flex-col gap-2 rounded-3xl bg-white p-2 shadow-xl shadow-luma-700/10 sm:flex-row">
            <label className="relative flex-1">
              <span className="sr-only">{t('market.search_label')}</span>
              <Search className="pointer-events-none absolute start-4 top-1/2 size-5 -translate-y-1/2 text-ink-muted" aria-hidden />
              <input name="q" type="search" maxLength={80} placeholder={t('market.search_placeholder')} className="h-12 w-full rounded-2xl bg-transparent ps-11 pe-3 outline-none" />
            </label>
            <button type="submit" className="h-12 rounded-2xl bg-luma-700 px-6 font-medium text-white hover:bg-luma-800">{t('market.hub.search')}</button>
          </form>
        </div>
      </section>

      <section className="mx-auto -mt-2 grid max-w-6xl gap-4 px-4 py-10 md:grid-cols-2" aria-label={t('market.hub.doors')}>
        {doors.map(({ key, href, Icon, n }) => (
          <Link key={key} href={href} className="group relative flex items-center gap-5 overflow-hidden rounded-3xl border border-luma-200 bg-white p-6 shadow-sm transition hover:-translate-y-0.5 hover:shadow-lg hover:shadow-luma-700/10 md:p-8">
            <span className="grid size-16 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-luma-500 to-luma-800 text-white shadow-lg shadow-luma-700/20"><Icon className="size-8" aria-hidden /></span>
            <span className="flex-1">
              <span className="block text-xl font-semibold text-luma-900">{t(`market.doors.${key}.title`)}</span>
              <span className="mt-1 block text-sm text-ink-muted">{t(`market.doors.${key}.body`)}</span>
              <span className="mt-2 block text-xs font-medium text-luma-700">{t('market.doors.count', { n })}</span>
            </span>
            <ArrowLeft className={`size-5 text-luma-500 transition group-hover:-translate-x-1 ${arrow}`} aria-hidden />
          </Link>
        ))}
      </section>

      {h.total === 0 ? (
        <section className="mx-auto max-w-6xl px-4 pb-6">
          <div className="rounded-3xl border border-dashed border-luma-300 bg-white/60 p-10 text-center">
            <p className="font-semibold text-luma-900">{t('market.hub.empty')}</p>
            <p className="mt-1 text-sm text-ink-muted">{t('market.hub.empty_hint')}</p>
          </div>
        </section>
      ) : null}

      {[['salons', h.salons], ['experts', h.experts]].map(([key, cards]) => (cards as typeof h.salons).length ? (
        <section key={key as string} className="mx-auto max-w-6xl px-4 py-6">
          <div className="mb-4 flex items-end justify-between gap-3">
            <h2 className="text-xl font-semibold text-luma-900">{t(`market.hub.top_${key}`)}</h2>
            <Link href={`/discover/${key}`} className="text-sm font-medium text-luma-700 hover:underline">{t('market.hub.see_all')}</Link>
          </div>
          <CardGrid cards={cards as typeof h.salons} signedIn={!!user} />
        </section>
      ) : null)}

      <section className="mx-auto max-w-6xl px-4 py-10">
        <div className="flex flex-col items-center justify-between gap-4 rounded-3xl bg-luma-700 p-8 text-center text-white md:flex-row md:text-start">
          <div>
            <p className="text-lg font-semibold">{t('market.hub.join_title')}</p>
            <p className="mt-1 text-sm text-luma-100">{t('market.hub.join_body')}</p>
          </div>
          <Link href="/auth/register?next=/app/new" className="rounded-xl bg-white px-5 py-2.5 font-medium text-luma-800">{t('market.hub.join_cta')}</Link>
        </div>
      </section>
    </>
  );
}

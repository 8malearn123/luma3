'use client';

import Link from 'next/link';
import { Compass, Heart } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { useApiQuery } from '../hooks';
import { Card } from '../components/layout';
import { EmptyState, ErrorState, LoadingState } from '../components/feedback';
import { BusinessCard, type MarketCardData } from '../market/BusinessCard';

type Explore = { favorites: MarketCardData[]; suggestions: MarketCardData[] };

/** «استكشفي»: favourite businesses and simple suggestions (same city, then top rated). */
export function ExplorePanel() {
  const { t } = useI18n();
  const q = useApiQuery<Explore>(['account', 'explore'], '/api/v1/account/explore');
  if (q.isLoading) return <LoadingState rows={4} />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data!;
  const grid = (cards: MarketCardData[]) => (
    <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {cards.map((c) => <li key={c.slug}><BusinessCard card={c} signedIn onFavoriteChange={() => q.refetch()} /></li>)}
    </ul>
  );
  return (
    <div className="flex flex-col gap-5">
      <Card title={<span className="inline-flex items-center gap-2"><Heart className="size-4 text-luma-700" aria-hidden />{t('market.explore.favorites')}</span>}>
        {d.favorites.length ? grid(d.favorites) : (
          <EmptyState title={t('market.explore.no_favorites')} hint={t('market.explore.no_favorites_hint')}
            action={<Link href="/discover" className="rounded-lg bg-luma-700 px-4 py-2 text-sm text-white">{t('market.explore.browse')}</Link>} />
        )}
      </Card>
      <Card title={<span className="inline-flex items-center gap-2"><Compass className="size-4 text-luma-700" aria-hidden />{t('market.explore.suggested')}</span>}
        actions={<Link href="/discover" className="text-sm text-luma-700 hover:underline">{t('market.hub.see_all')}</Link>}>
        {d.suggestions.length ? grid(d.suggestions) : <p className="text-sm text-ink-muted">{t('market.explore.no_suggestions')}</p>}
      </Card>
    </div>
  );
}

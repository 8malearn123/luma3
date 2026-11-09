'use client';

import Link from 'next/link';
import { useState } from 'react';
import { BadgeCheck, Heart, MapPin, Navigation, Star } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { formatMoney, formatNumber } from '@/shared/format';
import { api } from '../api';
import { cx } from '../components/cx';

export type MarketCardData = {
  slug: string; name: string; business_type: string; city: string | null; tagline_ar: string | null; tagline_en: string | null;
  logo_url: string | null; cover_url: string | null; verified: boolean; rating_avg: number | null; rating_count: number;
  starting_price_minor: number | null; currency: string; specialties: Array<{ slug: string; name_ar: string | null; name_en: string | null }>;
  distance_km: number | null; favorite: boolean; reason?: 'same_city' | 'top_rated';
};

/** The marketplace link carries the attribution marker read by the storefront (see MarketAttribution). */
export const storefrontHref = (slug: string) => `/s/${slug}?via=luma_market`;

export function VerifiedBadge({ className }: { className?: string }) {
  const { t } = useI18n();
  return (
    <span className={cx('inline-flex items-center gap-1 rounded-full bg-luma-700 px-2 py-0.5 text-[11px] font-medium text-white', className)} title={t('market.verified_hint')}>
      <BadgeCheck className="size-3.5" aria-hidden />{t('market.verified')}
    </span>
  );
}

export function FavoriteButton({ slug, initial, signedIn, onChange }: { slug: string; initial: boolean; signedIn: boolean; onChange?: (v: boolean) => void }) {
  const { t } = useI18n();
  const [on, setOn] = useState(initial);
  const [busy, setBusy] = useState(false);
  const label = on ? t('market.unfavorite') : t('market.favorite');
  const cls = 'grid size-9 place-items-center rounded-full bg-white/90 text-luma-700 shadow-sm backdrop-blur transition hover:scale-105';
  if (!signedIn) {
    return <Link href={`/auth/login?next=${encodeURIComponent('/discover')}`} aria-label={t('market.login_to_favorite')} title={t('market.login_to_favorite')} className={cls}><Heart className="size-4" aria-hidden /></Link>;
  }
  return (
    <button type="button" aria-pressed={on} aria-label={label} title={label} disabled={busy} className={cls}
      onClick={async () => {
        setBusy(true);
        const next = !on;
        try {
          if (next) await api('/api/v1/account/favorites', { body: { slug } });
          else await api(`/api/v1/account/favorites/${slug}`, { method: 'DELETE' });
          setOn(next); onChange?.(next);
        } catch { /* keep state */ } finally { setBusy(false); }
      }}>
      <Heart className={cx('size-4', on && 'fill-current')} aria-hidden />
    </button>
  );
}

export function BusinessCard({ card, signedIn, onFavoriteChange }: { card: MarketCardData; signedIn: boolean; onFavoriteChange?: (v: boolean) => void }) {
  const { t, pick, locale } = useI18n();
  const tagline = pick(card.tagline_ar, card.tagline_en);
  const initial = card.name.trim().charAt(0);
  return (
    <article className="group relative flex flex-col overflow-hidden rounded-3xl border border-luma-200 bg-white shadow-sm transition hover:-translate-y-0.5 hover:shadow-lg hover:shadow-luma-700/10">
      <div className="relative aspect-[16/9] overflow-hidden bg-gradient-to-br from-luma-200 via-luma-100 to-luma-300">
        <Link href={storefrontHref(card.slug)} tabIndex={-1} aria-hidden className="absolute inset-0">
          {card.cover_url
            // eslint-disable-next-line @next/next/no-img-element
            ? <img src={card.cover_url} alt="" loading="lazy" className="size-full object-cover transition duration-500 group-hover:scale-105" />
            : <div className="luma-pattern absolute inset-0 opacity-60" />}
        </Link>
        <div className="pointer-events-none absolute inset-x-3 top-3 flex items-start justify-between gap-2">
          {card.verified ? <VerifiedBadge /> : <span />}
          <div className="pointer-events-auto relative z-10"><FavoriteButton slug={card.slug} initial={card.favorite} signedIn={signedIn} onChange={onFavoriteChange} /></div>
        </div>
      </div>
      <div className="relative flex flex-1 flex-col gap-2 px-4 pb-4 pt-9">
        <div className="pointer-events-none absolute -top-7 start-4 z-10 grid size-14 place-items-center overflow-hidden rounded-2xl border-4 border-white bg-luma-700 text-xl font-semibold text-white shadow">
          {card.logo_url
            // eslint-disable-next-line @next/next/no-img-element
            ? <img src={card.logo_url} alt="" loading="lazy" className="size-full bg-white object-contain" />
            : <span aria-hidden>{initial}</span>}
        </div>
        <div className="flex items-start justify-between gap-2">
          <h3 className="font-semibold leading-snug text-luma-900">
            <Link href={storefrontHref(card.slug)} className="after:absolute after:inset-0">{card.name}</Link>
          </h3>
          {card.rating_avg != null ? (
            <span className="inline-flex shrink-0 items-center gap-1 text-sm font-medium text-luma-800" aria-label={t('market.rating_aria', { avg: card.rating_avg, n: card.rating_count })}>
              <Star className="size-4 fill-amber-400 text-amber-400" aria-hidden />{formatNumber(card.rating_avg, locale, { maximumFractionDigits: 1 })}
              <span className="text-xs font-normal text-ink-muted">({formatNumber(card.rating_count, locale)})</span>
            </span>
          ) : <span className="shrink-0 text-xs text-ink-muted">{t('market.new')}</span>}
        </div>
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-muted">
          <span>{t(`market.types.${card.business_type}`)}</span>
          {card.city ? <span className="inline-flex items-center gap-1"><MapPin className="size-3.5" aria-hidden />{card.city}</span> : null}
          {card.distance_km != null ? <span className="inline-flex items-center gap-1"><Navigation className="size-3.5" aria-hidden />{t('market.km', { km: formatNumber(card.distance_km, locale, { maximumFractionDigits: 1 }) })}</span> : null}
        </p>
        {tagline ? <p className="line-clamp-2 text-sm text-ink-muted">{tagline}</p> : null}
        {card.specialties.length ? (
          <ul className="flex flex-wrap gap-1.5">
            {card.specialties.slice(0, 3).map((s) => <li key={s.slug} className="rounded-full bg-luma-50 px-2 py-0.5 text-[11px] text-luma-800">{pick(s.name_ar, s.name_en)}</li>)}
          </ul>
        ) : null}
        <div className="mt-auto flex items-center justify-between pt-2 text-sm">
          {card.starting_price_minor != null
            ? <span><span className="text-xs text-ink-muted">{t('market.starting_from')} </span><span className="font-semibold text-luma-900">{formatMoney(card.starting_price_minor, card.currency, locale)}</span></span>
            : <span />}
          {card.reason ? <span className="text-[11px] text-ink-muted">{t(`market.reason.${card.reason}`)}</span> : <span className="text-xs font-medium text-luma-700">{t('market.book')}</span>}
        </div>
      </div>
    </article>
  );
}

export function CardGrid({ cards, signedIn }: { cards: MarketCardData[]; signedIn: boolean }) {
  return (
    <ul className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {cards.map((c) => <li key={c.slug} className="flex"><div className="w-full"><BusinessCard card={c} signedIn={signedIn} /></div></li>)}
    </ul>
  );
}

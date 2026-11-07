'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { CalendarClock, CalendarDays, Gauge, Newspaper, Sparkles, Star, TrendingUp, Users, Wallet } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { formatDate, formatNumber, formatTime } from '@/shared/format';
import { PLAN_FEATURES } from '@/shared/plans';
import { useApiQuery } from '../hooks';
import { useAccess } from '../shell/access-context';
import { Card, Stat } from '../components/layout';
import { Alert, Badge, ErrorState, LoadingState } from '../components/feedback';
import { cx } from '../components/cx';
import { useFmt } from '../commerce/common';
import { BookingStatusBadge } from '../bookings/common';
import { StoreQrCard } from './StoreQr';

type Appt = { id: string; number: string; status: string; starts_at: string; ends_at: string; customer_name: string; services: string | null; staff_names: string | null; total_minor?: number };
type Reviews = { average: number | null; count: number; items: Array<{ id: string; rating: number; comment: string | null; created_at: string; customer_name: string; staff_name: string | null }> } | null;
type Plan = { plan_code: string | null; items: Array<{ key: string; used: number; limit: number | null; ratio: number | null; near_limit: boolean }>; nudge: boolean } | null;
type Series = Array<{ date: string; bookings: number; sales_minor?: number }> | null;
type Store = { path: string; live: boolean; logo_asset_id: string | null };
type Perms = { money: boolean; allBookings: boolean; ownBookings: boolean; team: boolean; occupancy: boolean; reviews: boolean; plan: boolean };

export type OverviewData =
  | {
    variant: 'business'; store: Store; date: string; timezone: string; greeting_name: string | null; perms: Perms;
    kpis: { bookings_today: number | null; bookings_by_status: Record<string, number> | null; expected_revenue_today_minor: number | null; staff_on_duty: { on_duty: number; total: number } | null; occupancy_today: number | null };
    series: Series; next_appointments: Appt[] | null;
    staff_today: Array<{ staff_id: string; display_name: string; on_duty: boolean; bookings: number; occupancy: number | null; next_at: string | null }> | null;
    latest_reviews: Reviews; plan_usage: Plan;
  }
  | {
    variant: 'expert'; store: Store; date: string; timezone: string; greeting_name: string | null; perms: Perms;
    today: { bookings: number; by_status: Record<string, number>; expected_revenue_minor?: number } | null;
    my_appointments_today: Appt[] | null; next_appointments: Appt[] | null;
    earnings_month: { amount_minor: number; completed: number; month: string } | null;
    profile_completion: { percent: number; items: Array<{ key: string; ok: boolean; action_path: string }> };
    latest_reviews: Reviews; series: Series; plan_usage: Plan;
  };

export const overviewKey = (slug: string) => ['overview', slug];

/** Seven daily columns with values as text (sr-only table), no chart library. */
export function DayColumns({ points, label, format = (v) => String(v) }: { points: Array<{ date: string; value: number }>; label: string; format?: (v: number) => string }) {
  const { locale } = useI18n();
  const max = Math.max(1, ...points.map((p) => p.value));
  return (
    <figure>
      <div className="flex h-32 items-end gap-1.5" aria-hidden>
        {points.map((p, i) => (
          <div key={p.date} className="flex h-full flex-1 flex-col items-center justify-end gap-1">
            <span className="text-[10px] tabular-nums text-ink-muted" dir="ltr">{p.value ? format(p.value) : ''}</span>
            <div className={cx('w-full rounded-t-md', i === points.length - 1 ? 'bg-luma-700' : 'bg-luma-300')} style={{ height: `${Math.max(3, (p.value / max) * 100)}%` }} />
            <span className="text-[10px] text-ink-muted">{new Intl.DateTimeFormat(locale === 'ar' ? 'ar-SA-u-nu-latn' : 'en', { weekday: 'short', timeZone: 'UTC' }).format(new Date(`${p.date}T12:00:00Z`))}</span>
          </div>
        ))}
      </div>
      <table className="sr-only"><caption>{label}</caption><tbody>{points.map((p) => <tr key={p.date}><th scope="row">{p.date}</th><td>{format(p.value)}</td></tr>)}</tbody></table>
    </figure>
  );
}

function Stars({ n }: { n: number }) {
  return <span className="inline-flex text-amber-500" aria-label={`${n}/5`}>{Array.from({ length: 5 }, (_, i) => <Star key={i} className={cx('size-3.5', i < n ? 'fill-current' : 'opacity-30')} aria-hidden />)}</span>;
}

function useWhen() {
  const { locale, timeFormat } = useI18n();
  const access = useAccess();
  return { time: (v: string) => formatTime(v, { tz: access.timezone, locale, timeFormat }), day: (v: string) => formatDate(v, { tz: access.timezone, locale, weekday: true }) };
}

function Appointments({ items, empty, showDay }: { items: Appt[]; empty: string; showDay?: boolean }) {
  const access = useAccess();
  const { money } = useFmt();
  const w = useWhen();
  if (!items.length) return <p className="text-sm text-ink-muted">{empty}</p>;
  return (
    <ul className="flex flex-col divide-y divide-line">
      {items.map((a) => (
        <li key={a.id}>
          <Link href={`/app/${access.slug}/bookings/${a.id}`} className="flex items-center gap-3 py-2.5 hover:bg-luma-50">
            <div className="w-16 shrink-0 text-center">
              <p className="text-sm font-semibold tabular-nums">{w.time(a.starts_at)}</p>
              {showDay ? <p className="text-[10px] text-ink-muted">{w.day(a.starts_at)}</p> : null}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{a.customer_name}</p>
              <p className="truncate text-xs text-ink-muted">{a.services}{a.staff_names ? ` · ${a.staff_names}` : ''}</p>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1">
              <BookingStatusBadge status={a.status} />
              {a.total_minor !== undefined ? <span className="text-xs tabular-nums text-ink-muted">{money(a.total_minor)}</span> : null}
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function ReviewsCard({ reviews }: { reviews: NonNullable<Reviews> }) {
  const { t } = useI18n();
  const access = useAccess();
  const w = useWhen();
  return (
    <Card title={t('business.overview.latest_reviews')} actions={reviews.average !== null ? <span className="text-sm text-ink-muted">{t('business.overview.avg_rating', { avg: reviews.average.toFixed(1), n: reviews.count })}</span> : null}>
      {reviews.items.length ? (
        <ul className="flex flex-col gap-3">
          {reviews.items.map((r) => (
            <li key={r.id} className="text-sm">
              <div className="flex items-center justify-between gap-2"><Stars n={r.rating} /><span className="text-xs text-ink-muted">{w.day(r.created_at)}</span></div>
              {r.comment ? <p className="mt-1 line-clamp-2">{r.comment}</p> : null}
              <p className="mt-0.5 text-xs text-ink-muted">{r.customer_name}{r.staff_name ? ` · ${r.staff_name}` : ''}</p>
            </li>
          ))}
        </ul>
      ) : <p className="text-sm text-ink-muted">{t('business.overview.no_reviews')}</p>}
      {access.can('customers.view') ? <Link href={`/app/${access.slug}/customers`} className="mt-3 inline-block text-xs text-luma-700 underline">{t('business.overview.all_reviews')}</Link> : null}
    </Card>
  );
}

function PlanNudge({ plan }: { plan: NonNullable<Plan> }) {
  const { t, locale } = useI18n();
  const access = useAccess();
  if (!plan.nudge) return null;
  const near = plan.items.filter((i) => i.near_limit);
  return (
    <Alert tone="warn" title={t('business.overview.plan_nudge_title')}>
      <ul className="mt-1 flex flex-col gap-0.5">
        {near.map((i) => {
          const meta = PLAN_FEATURES[i.key as keyof typeof PLAN_FEATURES];
          return <li key={i.key}>{t('business.overview.plan_usage_line', { what: meta ? (locale === 'ar' ? meta.label_ar : meta.label_en) : i.key, used: i.used, limit: i.limit ?? '∞' })}</li>;
        })}
      </ul>
      {access.can('subscription.manage', 'subscription.view') ? <Link href={`/app/${access.slug}/settings?tab=subscription`} className="mt-2 inline-block font-medium underline">{t('business.overview.upgrade')}</Link> : null}
    </Alert>
  );
}

function StoreCard({ store }: { store: Store }) {
  const { t } = useI18n();
  const access = useAccess();
  if (!store.live && !access.can('builder.edit', 'business.manage')) return null;
  return (
    <Card title={t('business.qr.title')}>
      {!store.live ? <p className="mb-3 text-xs text-ink-muted">{t('business.qr.not_live')}</p> : null}
      <StoreQrCard slug={access.slug} name={access.name} logoAssetId={store.logo_asset_id} />
    </Card>
  );
}

function DigestLink() {
  const { t } = useI18n();
  const access = useAccess();
  if (!access.can('business.manage', 'analytics.view')) return null;
  return (
    <Link href={`/app/${access.slug}/digest`} className="flex items-center gap-3 rounded-2xl border border-line bg-white p-4 shadow-sm hover:border-luma-300">
      <Newspaper className="size-5 text-luma-500" aria-hidden />
      <span className="text-sm"><span className="block font-medium">{t('business.digest.title')}</span><span className="text-xs text-ink-muted">{t('business.digest.overview_hint')}</span></span>
    </Link>
  );
}

function Charts({ series, money }: { series: NonNullable<Series>; money: boolean }) {
  const { t, locale } = useI18n();
  const access = useAccess();
  const fmtMoneyShort = (v: number) => formatNumber(Math.round(v / 100), locale, { notation: 'compact' });
  return (
    <div className={cx('grid gap-4', money && 'lg:grid-cols-2')}>
      <Card title={<span className="inline-flex items-center gap-2"><CalendarDays className="size-4 text-luma-500" aria-hidden />{t('business.overview.chart_bookings')}</span>}>
        <DayColumns points={series.map((p) => ({ date: p.date, value: p.bookings }))} label={t('business.overview.chart_bookings')} />
      </Card>
      {money ? (
        <Card title={<span className="inline-flex items-center gap-2"><TrendingUp className="size-4 text-luma-500" aria-hidden />{t('business.overview.chart_sales', { currency: access.currency })}</span>}>
          <DayColumns points={series.map((p) => ({ date: p.date, value: p.sales_minor ?? 0 }))} label={t('business.overview.chart_sales', { currency: access.currency })} format={fmtMoneyShort} />
          <p className="mt-1 text-[11px] text-ink-muted">{t('business.overview.sales_basis')}</p>
        </Card>
      ) : null}
    </div>
  );
}

function Kpi({ icon, label, value, hint }: { icon: ReactNode; label: string; value: ReactNode; hint?: ReactNode }) {
  return <Stat label={<span className="inline-flex items-center gap-1.5">{icon}{label}</span>} value={value} hint={hint} />;
}

function BusinessView({ d }: { d: Extract<OverviewData, { variant: 'business' }> }) {
  const { t, locale } = useI18n();
  const access = useAccess();
  const { money } = useFmt();
  const w = useWhen();
  const k = d.kpis;
  const pct = (v: number | null) => (v === null ? '—' : `${formatNumber(Math.round(v * 100), locale)}%`);
  return (
    <div className="flex flex-col gap-5">
      {d.plan_usage ? <PlanNudge plan={d.plan_usage} /> : null}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="overview-kpis">
        {k.bookings_today !== null ? <Kpi icon={<CalendarDays className="size-3.5" aria-hidden />} label={t(d.perms.allBookings ? 'business.overview.kpi_bookings_today' : 'business.overview.kpi_my_bookings_today')} value={formatNumber(k.bookings_today, locale)}
          hint={k.bookings_by_status?.completed ? t('business.overview.completed_n', { n: k.bookings_by_status.completed }) : undefined} /> : null}
        {k.expected_revenue_today_minor !== null ? <Kpi icon={<Wallet className="size-3.5" aria-hidden />} label={t('business.overview.kpi_expected_revenue')} value={money(k.expected_revenue_today_minor)} /> : null}
        {k.staff_on_duty ? <Kpi icon={<Users className="size-3.5" aria-hidden />} label={t('business.overview.kpi_staff_on_duty')} value={`${formatNumber(k.staff_on_duty.on_duty, locale)} / ${formatNumber(k.staff_on_duty.total, locale)}`} /> : null}
        {d.perms.occupancy ? <Kpi icon={<Gauge className="size-3.5" aria-hidden />} label={t(access.businessType === 'salon' ? 'business.overview.kpi_chair_occupancy' : 'business.overview.kpi_occupancy')} value={pct(k.occupancy_today)} hint={k.occupancy_today === null ? t('business.overview.no_hours_today') : undefined} /> : null}
      </div>
      {d.series ? <Charts series={d.series} money={d.perms.money} /> : null}
      <div className="grid gap-4 lg:grid-cols-3">
        {d.next_appointments ? (
          <Card className="lg:col-span-2" title={<span className="inline-flex items-center gap-2"><CalendarClock className="size-4 text-luma-500" aria-hidden />{t('business.overview.next_appointments')}</span>}
            actions={<Link href={`/app/${access.slug}/bookings`} className="text-xs text-luma-700 underline">{t('business.overview.all_bookings')}</Link>}>
            <Appointments items={d.next_appointments} empty={t('business.overview.no_upcoming')} showDay />
          </Card>
        ) : null}
        {d.staff_today ? (
          <Card title={<span className="inline-flex items-center gap-2"><Users className="size-4 text-luma-500" aria-hidden />{t('business.overview.staff_today')}</span>}>
            {d.staff_today.length ? (
              <ul className="flex flex-col gap-2">
                {d.staff_today.map((s) => (
                  <li key={s.staff_id} className="flex items-center justify-between gap-2 text-sm">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className={cx('size-2 shrink-0 rounded-full', s.on_duty ? 'bg-ok' : 'bg-line')} aria-hidden />
                      <span className="truncate">{s.display_name}</span>
                      {!s.on_duty ? <Badge>{t('business.overview.off_today')}</Badge> : null}
                    </span>
                    <span className="shrink-0 text-xs text-ink-muted">
                      {t('business.overview.n_bookings', { n: s.bookings })}{s.occupancy !== null ? ` · ${pct(s.occupancy)}` : ''}{s.next_at ? ` · ${t('business.overview.next_at', { time: w.time(s.next_at) })}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            ) : <p className="text-sm text-ink-muted">{t('business.overview.nobody_today')}</p>}
          </Card>
        ) : null}
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        {d.latest_reviews ? <ReviewsCard reviews={d.latest_reviews} /> : null}
        <div className="flex flex-col gap-4 lg:col-span-2">
          <StoreCard store={d.store} />
          <DigestLink />
        </div>
      </div>
    </div>
  );
}

function ExpertView({ d }: { d: Extract<OverviewData, { variant: 'expert' }> }) {
  const { t, locale } = useI18n();
  const access = useAccess();
  const { money } = useFmt();
  const pc = d.profile_completion;
  return (
    <div className="flex flex-col gap-5">
      {d.plan_usage ? <PlanNudge plan={d.plan_usage} /> : null}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="overview-kpis">
        {d.today ? <Kpi icon={<CalendarDays className="size-3.5" aria-hidden />} label={t('business.overview.kpi_my_bookings_today')} value={formatNumber(d.today.bookings, locale)} /> : null}
        {d.today?.expected_revenue_minor !== undefined ? <Kpi icon={<Wallet className="size-3.5" aria-hidden />} label={t('business.overview.kpi_expected_revenue')} value={money(d.today.expected_revenue_minor)} /> : null}
        {d.earnings_month ? <Kpi icon={<TrendingUp className="size-3.5" aria-hidden />} label={t('business.overview.kpi_my_earnings')} value={money(d.earnings_month.amount_minor)} hint={t('business.overview.completed_n', { n: d.earnings_month.completed })} /> : null}
        <Kpi icon={<Sparkles className="size-3.5" aria-hidden />} label={t('business.overview.kpi_profile')} value={`${formatNumber(pc.percent, locale)}%`} />
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        {d.my_appointments_today ? (
          <Card className="lg:col-span-2" title={<span className="inline-flex items-center gap-2"><CalendarClock className="size-4 text-luma-500" aria-hidden />{t('business.overview.my_appointments_today')}</span>}
            actions={<Link href={`/app/${access.slug}/bookings`} className="text-xs text-luma-700 underline">{t('business.overview.all_bookings')}</Link>}>
            <Appointments items={d.my_appointments_today} empty={t('business.overview.free_today')} />
            {d.next_appointments && d.next_appointments.length > d.my_appointments_today.length ? (
              <>
                <h3 className="mb-1 mt-4 text-xs font-semibold text-ink-muted">{t('business.overview.coming_up')}</h3>
                <Appointments items={d.next_appointments.filter((a) => !d.my_appointments_today!.some((m) => m.id === a.id)).slice(0, 4)} empty="" showDay />
              </>
            ) : null}
          </Card>
        ) : null}
        <Card title={t('business.overview.profile_completion')}>
          <div className="mb-3 h-2 overflow-hidden rounded-full bg-luma-100" role="progressbar" aria-valuenow={pc.percent} aria-valuemin={0} aria-valuemax={100} aria-label={t('business.overview.profile_completion')}>
            <div className="h-full rounded-full bg-luma-700" style={{ width: `${pc.percent}%` }} />
          </div>
          <ul className="flex flex-col gap-1.5 text-sm">
            {pc.items.map((i) => (
              <li key={i.key} className="flex items-center gap-2">
                <span className={cx('size-2 rounded-full', i.ok ? 'bg-ok' : 'bg-warn')} aria-hidden />
                {i.ok ? <span className="text-ink-muted line-through">{t(`business.profile.${i.key}`)}</span> : <Link className="underline" href={i.action_path}>{t(`business.profile.${i.key}`)}</Link>}
                <span className="sr-only">{i.ok ? t('business.profile.done') : t('business.profile.todo')}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
      {d.series ? <Charts series={d.series} money={d.perms.money} /> : null}
      <div className="grid gap-4 lg:grid-cols-3">
        {d.latest_reviews ? <ReviewsCard reviews={d.latest_reviews} /> : null}
        <div className="flex flex-col gap-4 lg:col-span-2"><StoreCard store={d.store} /><DigestLink /></div>
      </div>
    </div>
  );
}

/** Overview dashboard (business or independent-expert variant); refetches when the branch switcher changes. */
export function BusinessOverview() {
  const { t, locale } = useI18n();
  const access = useAccess();
  const q = useApiQuery<OverviewData>(overviewKey(access.slug), access.api('/overview'), { refetchInterval: 120_000 });
  if (q.isLoading) return <LoadingState rows={6} />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data;
  return (
    <div className="flex flex-col gap-5">
      {d.greeting_name ? <p className="text-sm text-ink-muted">{t(d.variant === 'expert' ? 'business.overview.hello_expert' : 'business.overview.hello', { name: d.greeting_name.split(/\s+/)[0] ?? '' })} · {formatDate(`${d.date}T12:00:00Z`, { tz: 'UTC', locale, weekday: true })}</p> : null}
      {d.variant === 'expert' ? <ExpertView d={d} /> : <BusinessView d={d} />}
    </div>
  );
}

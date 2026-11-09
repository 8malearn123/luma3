'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Activity, CalendarPlus, CreditCard, ShoppingBag, Star, Store, type LucideIcon } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { useApiQuery } from '../../hooks';
import { EmptyState, ErrorState, LoadingState } from '../../components/feedback';
import { Card, PageHeader } from '../../components/layout';
import { Money, When } from '../common';
import { usePlatform } from '../PlatformShell';

type Item = { id: string; kind: 'booking' | 'payment' | 'order' | 'review' | 'signup'; at: string; tenant_slug: string; tenant_name: string; amount_minor: number | null; currency: string | null; detail: string | null; link: string };
const ICON: Record<Item['kind'], LucideIcon> = { booking: CalendarPlus, payment: CreditCard, order: ShoppingBag, review: Star, signup: Store };
const SEEN_KEY = 'luma_platform_feed_seen';

function readSeen() {
  try { return localStorage.getItem(SEEN_KEY); } catch { return null; }
}
function writeSeen(v: string) {
  try { localStorage.setItem(SEEN_KEY, v); } catch { /* private mode */ }
}

function FeedRow({ i }: { i: Item }) {
  const { t } = useI18n();
  const I = ICON[i.kind];
  return (
    <Link href={i.link} className="flex items-start gap-3 rounded-lg px-3 py-2 text-sm hover:bg-luma-50">
      <I className="mt-0.5 size-4 shrink-0 text-luma-700" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="font-medium">{t(`admin.feed.kinds.${i.kind}`)}</span> · {i.tenant_name}
        {i.amount_minor != null ? <> · <Money minor={i.amount_minor} currency={i.currency ?? 'SAR'} /></> : null}
        {i.detail ? <span className="block truncate text-xs text-ink-muted" dir="auto">{i.detail}</span> : null}
      </span>
      <span className="shrink-0 text-xs text-ink-muted"><When v={i.at} /></span>
    </Link>
  );
}

/** Header bell for platform staff with platform.feed.view; polls every 20s. "New" = since last opened (per browser). */
export function PlatformFeedBell() {
  const { t } = useI18n();
  const { can } = usePlatform();
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState<string | null>(null);
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setSeen(readSeen()); }, []);
  const q = useApiQuery<{ items: Item[]; server_time: string }>(['platform', 'feed', 'bell'], can('platform.feed.view') ? '/api/v1/platform/feed?limit=15' : null, { refetchInterval: 20_000 });
  if (!can('platform.feed.view')) return null;
  const items = q.data?.items ?? [];
  const fresh = seen ? items.filter((i) => i.at > seen).length : items.length;
  function toggle() {
    setOpen((o) => !o);
    if (q.data) { writeSeen(q.data.server_time); setSeen(q.data.server_time); }
  }
  return (
    <div className="relative">
      <button onClick={toggle} aria-label={`${t('admin.feed.bell')}${fresh ? ` (${t('admin.feed.new', { n: fresh })})` : ''}`} className="relative rounded-lg p-2 hover:bg-luma-100">
        <Activity className="size-5" />
        {fresh ? <span className="absolute -top-0.5 -end-0.5 min-w-4 rounded-full bg-ok px-1 text-center text-[10px] text-white">{fresh > 9 ? '9+' : fresh}</span> : null}
      </button>
      {open ? (
        <div className="absolute end-0 z-40 mt-1 max-h-[70vh] w-96 max-w-[90vw] overflow-y-auto rounded-xl border border-line bg-white p-1 shadow-lg">
          {items.length ? items.map((i) => <FeedRow key={i.id} i={i} />) : <p className="p-4 text-center text-sm text-ink-muted">{t('admin.feed.empty')}</p>}
          <Link href="/platform/feed" onClick={() => setOpen(false)} className="block border-t border-line px-3 py-2 text-center text-sm text-luma-700">{t('admin.feed.see_all')}</Link>
        </div>
      ) : null}
    </div>
  );
}

export function FeedPage() {
  const { t } = useI18n();
  const q = useApiQuery<{ items: Item[] }>(['platform', 'feed', 'page'], '/api/v1/platform/feed?limit=100', { refetchInterval: 15_000 });
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={t('admin.feed.title')} subtitle={t('admin.feed.subtitle')} />
      <Card>
        {q.isLoading ? <LoadingState rows={6} /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !q.data!.items.length ? <EmptyState title={t('admin.feed.empty')} /> : (
          <div aria-live="polite" className="flex flex-col divide-y divide-line">{q.data!.items.map((i) => <FeedRow key={i.id} i={i} />)}</div>
        )}
      </Card>
    </div>
  );
}

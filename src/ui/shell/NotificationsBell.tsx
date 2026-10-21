'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Bell } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useI18n } from '@/i18n/client';
import { useApiQuery } from '../hooks';
import { api } from '../api';
import { formatDateTime } from '@/shared/format';

type N = { id: string; title_ar: string; title_en: string; body_ar: string | null; body_en: string | null; target_path: string | null; read_at: string | null; created_at: string };

/** Persisted notifications; polled every 30s (considered polling instead of browser storage). */
export function NotificationsBell() {
  const { t, locale, pick, timeFormat } = useI18n();
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const q = useApiQuery<{ items: N[]; unread: number }>(['notifications'], '/api/v1/notifications', { refetchInterval: 30_000 });
  const unread = q.data?.unread ?? 0;
  return (
    <div className="relative">
      <button onClick={() => setOpen((o) => !o)} aria-label={`${t('a11y.notifications')}${unread ? ` (${unread})` : ''}`} className="relative rounded-lg p-2 hover:bg-luma-100">
        <Bell className="size-5" />
        {unread ? <span className="absolute -top-0.5 -end-0.5 min-w-4 rounded-full bg-luma-700 px-1 text-center text-[10px] text-white">{unread > 9 ? '9+' : unread}</span> : null}
      </button>
      {open ? (
        <div className="absolute end-0 mt-1 max-h-[70vh] w-80 overflow-y-auto rounded-xl border border-line bg-white p-1 shadow-lg">
          {q.data?.items.length ? q.data.items.map((n) => (
            <Link key={n.id} href={n.target_path ?? '#'} onClick={async () => { setOpen(false); if (!n.read_at) { await api(`/api/v1/notifications/${n.id}/read`, { body: {} }).catch(() => {}); qc.invalidateQueries({ queryKey: ['notifications'] }); } }}
              className={`block rounded-lg px-3 py-2 text-sm hover:bg-luma-50 ${n.read_at ? 'text-ink-muted' : ''}`}>
              <p className={n.read_at ? '' : 'font-medium'}>{pick(n.title_ar, n.title_en)}</p>
              <p className="text-xs text-ink-muted">{formatDateTime(n.created_at, { locale, timeFormat })}</p>
            </Link>
          )) : <p className="p-4 text-center text-sm text-ink-muted">{t('states.empty')}</p>}
        </div>
      ) : null}
    </div>
  );
}

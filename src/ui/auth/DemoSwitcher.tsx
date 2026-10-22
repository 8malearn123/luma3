'use client';

import { useState } from 'react';
import { useI18n } from '@/i18n/client';
import { api } from '../api';
import { useApiQuery, useErrorMessage } from '../hooks';

/**
 * PRIVATE DEMO ONLY: one-click sign-in as seeded demo identities. The server
 * route returns 404 unless DEMO_MODE is on and APP_ENV is not production, and
 * it only accepts users flagged is_demo.
 */
export function DemoSwitcher({ next }: { next: string }) {
  const { t } = useI18n();
  const msg = useErrorMessage();
  const q = useApiQuery<Array<{ key: string; label: string; role: string }>>(['demo-users'], '/api/v1/demo/users');
  const [err, setErr] = useState<unknown>(null);
  if (!q.data?.length) return null;
  return (
    <div className="mt-6 rounded-xl border border-dashed border-luma-300 bg-luma-50 p-3">
      <p className="text-sm font-semibold text-luma-800">{t('auth.demo_title')}</p>
      <p className="mb-2 text-xs text-ink-muted">{t('auth.demo_hint')}</p>
      {err ? <p className="text-xs text-danger">{msg(err)}</p> : null}
      <div className="flex flex-wrap gap-1.5">
        {q.data.map((u) => (
          <button key={u.key} className="rounded-full border border-luma-300 bg-white px-3 py-1 text-xs hover:bg-luma-100"
            onClick={async () => {
              try { const r = await api<{ redirect: string }>('/api/v1/demo/sign-in', { body: { key: u.key } }); window.location.href = r.redirect || next; }
              catch (e) { setErr(e); }
            }}>{u.label}</button>
        ))}
      </div>
    </div>
  );
}

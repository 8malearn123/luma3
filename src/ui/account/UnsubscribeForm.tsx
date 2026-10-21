'use client';

import Link from 'next/link';
import { useState } from 'react';
import { MailX } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { api } from '../api';
import { useErrorMessage } from '../hooks';
import { Button } from '../components/button';
import { Alert } from '../components/feedback';

/** One click, no login. The GET page never mutates (mail scanners prefetch links). */
export function UnsubscribeForm({ token }: { token: string | null }) {
  const { t } = useI18n();
  const msg = useErrorMessage();
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  async function confirm() {
    if (!token) return;
    setBusy(true); setErr(null);
    try {
      const r = await api<{ business_name: string }>('/api/v1/unsubscribe', { body: { token } });
      setDone(r.business_name);
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }
  return (
    <div className="flex flex-col items-center gap-4 text-center">
      <MailX className="size-10 text-luma-500" aria-hidden />
      <h1 className="font-display text-2xl text-luma-900">{t('unsubscribe.title')}</h1>
      {!token ? <Alert tone="danger">{t('unsubscribe.invalid')}</Alert> : done ? (
        <Alert tone="ok">{t('unsubscribe.done', { business: done })}</Alert>
      ) : (
        <>
          <p className="text-sm text-ink-muted">{t('unsubscribe.body')}</p>
          {err ? <Alert tone="danger">{msg(err)}</Alert> : null}
          <Button loading={busy} onClick={confirm}>{t('unsubscribe.confirm')}</Button>
        </>
      )}
      <Link href="/account/privacy" className="text-sm text-luma-700 underline">{t('unsubscribe.manage')}</Link>
    </div>
  );
}

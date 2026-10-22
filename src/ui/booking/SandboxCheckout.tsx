'use client';

import { useState } from 'react';
import { FlaskConical } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { api } from '../api';
import { useErrorMessage } from '../hooks';
import { Button } from '../components/button';
import { Alert } from '../components/feedback';
import { formatMoney } from '@/shared/format';

export function SandboxCheckout({ id, amountMinor, currency, status, returnTo }: { id: string; amountMinor: number; currency: string; status: string; returnTo: string }) {
  const { t, locale } = useI18n();
  const msg = useErrorMessage();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [done, setDone] = useState(false);
  const run = async (outcome: 'captured' | 'failed' | 'cancelled') => {
    setBusy(outcome); setErr(null);
    try { await api(`/api/v1/sandbox/checkout/${id}`, { body: { outcome } }); setDone(true); setTimeout(() => { window.location.href = returnTo; }, 900); }
    catch (e) { setErr(e); } finally { setBusy(null); }
  };
  return (
    <div className="flex min-h-dvh items-center justify-center bg-slate-100 p-4">
      <div className="w-full max-w-md rounded-2xl border-2 border-dashed border-amber-400 bg-white p-6 shadow">
        <p className="mb-2 inline-flex items-center gap-2 rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-900"><FlaskConical className="size-4" />SANDBOX</p>
        <h1 className="text-xl font-semibold">{t('sandbox.title')}</h1>
        <Alert tone="warn" className="my-3">{t('sandbox.warning')}</Alert>
        <p className="text-sm text-slate-600">{t('sandbox.amount')}</p>
        <p className="mb-4 text-3xl font-semibold">{formatMoney(amountMinor, currency, locale)}</p>
        {err ? <p role="alert" className="mb-2 text-sm text-danger">{msg(err)}</p> : null}
        {done ? <p role="status" className="text-ok">{t('sandbox.done')}</p> : (
          <div className="flex flex-col gap-2">
            <Button size="lg" loading={busy === 'captured'} disabled={!!busy || status !== 'initiated'} onClick={() => run('captured')}>{t('sandbox.succeed')}</Button>
            <Button variant="outline" loading={busy === 'failed'} disabled={!!busy || status !== 'initiated'} onClick={() => run('failed')}>{t('sandbox.fail')}</Button>
            <Button variant="ghost" disabled={!!busy} onClick={() => run('cancelled')}>{t('sandbox.cancel')}</Button>
          </div>
        )}
      </div>
    </div>
  );
}

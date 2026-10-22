'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useI18n } from '@/i18n/client';
import { api } from '../api';
import { useErrorMessage } from '../hooks';
import { Button } from '../components/button';
import { Field, FormErrorSummary, Input } from '../components/form';
import { Alert } from '../components/feedback';
import { AuthCard, DeliveryNotice } from './AuthCard';

export function RecoverForm() {
  const { t, locale } = useI18n();
  const msg = useErrorMessage();
  const [identifier, setIdentifier] = useState('');
  const [stage, setStage] = useState<'request' | 'reset' | 'done'>('request');
  const [delivery, setDelivery] = useState<{ status: string; dev_code?: string } | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<void>) => { setBusy(true); setError(null); try { await fn(); } catch (e) { setError(e); } finally { setBusy(false); } };

  return (
    <AuthCard title={t('auth.recovery_title')} footer={<Link href="/auth/login" className="underline">{t('auth.login_title')}</Link>}>
      {stage === 'done' ? <Alert tone="ok">{t('auth.reset_done')}</Alert> : (
        <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); run(async () => {
          if (stage === 'request') {
            const r = await api<{ delivery: { status: string; dev_code?: string } }>('/api/v1/auth/recovery/request', { body: { identifier, locale } });
            setDelivery(r.delivery); setStage('reset');
          } else {
            await api('/api/v1/auth/recovery/reset', { body: { identifier, code, new_password: password } });
            setStage('done');
          }
        }); }}>
          <FormErrorSummary message={error ? msg(error) : null} />
          {stage === 'request' ? <p className="text-sm text-ink-muted">{t('auth.recovery_hint')}</p> : <DeliveryNotice delivery={delivery} />}
          <Field label={t('auth.identifier')} required>
            {(p) => <Input {...p} dir="ltr" value={identifier} disabled={stage === 'reset'} onChange={(e) => setIdentifier(e.target.value)} />}
          </Field>
          {stage === 'reset' ? (
            <>
              <Field label={t('auth.code')} required>{(p) => <Input {...p} dir="ltr" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />}</Field>
              <Field label={t('auth.new_password')} hint={t('auth.password_hint')} required>{(p) => <Input {...p} type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
            </>
          ) : null}
          <Button type="submit" size="lg" loading={busy}>{stage === 'request' ? t('auth.recovery_cta') : t('auth.reset_cta')}</Button>
        </form>
      )}
    </AuthCard>
  );
}

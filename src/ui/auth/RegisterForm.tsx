'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useI18n } from '@/i18n/client';
import { api, ApiError } from '../api';
import { useErrorMessage } from '../hooks';
import { Button } from '../components/button';
import { Field, FormErrorSummary, Input } from '../components/form';
import { AuthCard, DeliveryNotice } from './AuthCard';

export function RegisterForm({ next }: { next: string }) {
  const { t, locale } = useI18n();
  const msg = useErrorMessage();
  const [form, setForm] = useState({ display_name: '', identifier: '', password: '' });
  const [stage, setStage] = useState<'form' | 'verify'>('form');
  const [delivery, setDelivery] = useState<{ status: string; dev_code?: string } | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      const r = await api<{ delivery: { status: string; dev_code?: string } }>('/api/v1/auth/register', { body: { ...form, locale } });
      setDelivery(r.delivery); setStage('verify');
    } catch (err) { setError(err); } finally { setBusy(false); }
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      await api('/api/v1/auth/verify', { body: { identifier: form.identifier, code } });
      window.location.href = next;
    } catch (err) { setError(err); } finally { setBusy(false); }
  }

  const issues = error instanceof ApiError && error.code === 'validation_failed' ? (error.details?.issues as Array<{ path: string; message: string }>) : undefined;

  if (stage === 'verify') {
    return (
      <AuthCard title={t('auth.verify_title')}>
        <p className="mb-3 text-sm text-ink-muted">{t('auth.verify_sent', { dest: form.identifier })}</p>
        <DeliveryNotice delivery={delivery} />
        <form onSubmit={verify} className="flex flex-col gap-4">
          <FormErrorSummary message={error ? msg(error) : null} />
          <Field label={t('auth.code')} required>
            {(p) => <Input {...p} inputMode="numeric" autoComplete="one-time-code" dir="ltr" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} className="text-center font-mono text-lg tracking-[0.4em]" />}
          </Field>
          <Button type="submit" loading={busy} size="lg" disabled={code.length !== 6}>{t('auth.verify_cta')}</Button>
          <button type="button" className="text-sm text-luma-700 underline" onClick={() => setStage('form')}>{t('actions.back')}</button>
        </form>
      </AuthCard>
    );
  }

  return (
    <AuthCard title={t('auth.register_title')} footer={<>{t('auth.have_account')} <Link className="font-semibold underline" href={`/auth/login?next=${encodeURIComponent(next)}`}>{t('auth.login_title')}</Link></>}>
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <FormErrorSummary message={error ? msg(error) : null} issues={issues} />
        <Field label={t('auth.display_name')} required>
          {(p) => <Input {...p} autoComplete="name" value={form.display_name} onChange={(e) => setForm({ ...form, display_name: e.target.value })} />}
        </Field>
        <Field label={t('auth.identifier')} hint={t('auth.identifier_hint')} required>
          {(p) => <Input {...p} autoComplete="username" dir="ltr" value={form.identifier} onChange={(e) => setForm({ ...form, identifier: e.target.value })} />}
        </Field>
        <Field label={t('fields.password')} hint={t('auth.password_hint')} required>
          {(p) => <Input {...p} type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />}
        </Field>
        <Button type="submit" loading={busy} size="lg">{t('auth.register_cta')}</Button>
      </form>
    </AuthCard>
  );
}

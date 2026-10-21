'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useI18n } from '@/i18n/client';
import { api } from '../api';
import { useErrorMessage } from '../hooks';
import { Button } from '../components/button';
import { Field, FormErrorSummary, Input } from '../components/form';
import { AuthCard } from './AuthCard';
import { DemoSwitcher } from './DemoSwitcher';

export function LoginForm({ next, demo }: { next: string; demo: boolean }) {
  const { t } = useI18n();
  const msg = useErrorMessage();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await api('/api/v1/auth/login', { body: { identifier, password } });
      window.location.href = next;
    } catch (err) {
      setError(err); // inputs are preserved
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard title={t('auth.login_title')} footer={<>{t('auth.no_account')} <Link className="font-semibold underline" href={`/auth/register?next=${encodeURIComponent(next)}`}>{t('auth.register_title')}</Link></>}>
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <FormErrorSummary message={error ? msg(error) : null} />
        <Field label={t('auth.identifier')} hint={t('auth.identifier_hint')} required>
          {(p) => <Input {...p} autoComplete="username" dir="ltr" value={identifier} onChange={(e) => setIdentifier(e.target.value)} required />}
        </Field>
        <Field label={t('fields.password')} required>
          {(p) => <Input {...p} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />}
        </Field>
        <Button type="submit" loading={busy} size="lg">{t('auth.login_cta')}</Button>
        <Link href="/auth/recover" className="text-center text-sm text-luma-700 underline">{t('auth.forgot')}</Link>
      </form>
      {demo ? <DemoSwitcher next={next} /> : null}
    </AuthCard>
  );
}

'use client';

import { useState } from 'react';
import { KeyRound, LogOut, MonitorSmartphone } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useI18n } from '@/i18n/client';
import { formatDateTime } from '@/shared/format';
import { api } from '../api';
import { useApiQuery, useErrorMessage } from '../hooks';
import { Button } from '../components/button';
import { Badge, ErrorState, LoadingState } from '../components/feedback';
import { Field, FormErrorSummary, Input } from '../components/form';
import { Card } from '../components/layout';
import { useToast } from '../components/toast';

type Session = { id: string; created_at: string; last_seen_at: string; ip: string | null; user_agent: string | null; current: boolean };

function deviceLabel(ua: string | null) {
  if (!ua) return null;
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : null;
  const br = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : null;
  return [br, os].filter(Boolean).join(' · ') || null;
}

/** Uses the existing auth endpoints: GET/DELETE /api/v1/auth/sessions, POST /api/v1/auth/password. */
export function SecurityPanel() {
  const { t, locale, timeFormat } = useI18n();
  const msg = useErrorMessage();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useApiQuery<Session[]>(['account-sessions'], '/api/v1/auth/sessions');
  const [err, setErr] = useState<unknown>(null);
  const [pw, setPw] = useState({ current_password: '', new_password: '' });
  const [busy, setBusy] = useState(false);
  async function revoke(id?: string) {
    setErr(null);
    try {
      await api(id ? `/api/v1/auth/sessions/${id}` : '/api/v1/auth/sessions', { method: 'DELETE' });
      await qc.invalidateQueries({ queryKey: ['account-sessions'] });
    } catch (e) { setErr(e); }
  }
  async function change() {
    setBusy(true); setErr(null);
    try {
      await api('/api/v1/auth/password', { body: pw });
      setPw({ current_password: '', new_password: '' });
      toast({ tone: 'ok', text: t('account.security.changed') });
      await qc.invalidateQueries({ queryKey: ['account-sessions'] });
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }
  return (
    <div className="flex flex-col gap-4">
      <FormErrorSummary message={err ? msg(err) : null} />
      <Card title={t('account.security.sessions')} actions={q.data && q.data.length > 1 ? <Button size="sm" variant="outline" icon={<LogOut className="size-4" />} onClick={() => revoke()}>{t('account.security.revoke_others')}</Button> : null}>
        {q.isLoading ? <LoadingState rows={2} /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : (
          <ul className="divide-y divide-line">
            {q.data!.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-3 py-3 text-sm">
                <MonitorSmartphone className="size-5 text-luma-500" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{deviceLabel(s.user_agent) ?? t('account.security.unknown_device')} {s.current ? <Badge tone="ok">{t('account.security.current')}</Badge> : null}</p>
                  <p className="text-xs text-ink-muted">{t('account.security.last_seen')}: {formatDateTime(s.last_seen_at, { locale, timeFormat })}{s.ip ? <> · <span dir="ltr">{s.ip}</span></> : null}</p>
                </div>
                {!s.current ? <Button size="sm" variant="ghost" onClick={() => revoke(s.id)}>{t('account.security.revoke')}</Button> : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title={t('account.security.change_password')}>
        <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); void change(); }}>
          <Field label={t('account.security.current_password')} required>{(p) => <Input {...p} type="password" autoComplete="current-password" value={pw.current_password} onChange={(e) => setPw({ ...pw, current_password: e.target.value })} />}</Field>
          <Field label={t('account.security.new_password')} hint={t('auth.password_hint')} required>{(p) => <Input {...p} type="password" autoComplete="new-password" value={pw.new_password} onChange={(e) => setPw({ ...pw, new_password: e.target.value })} />}</Field>
          <div className="sm:col-span-2"><Button type="submit" icon={<KeyRound className="size-4" />} loading={busy} disabled={!pw.current_password || pw.new_password.length < 10}>{t('account.security.change_password')}</Button></div>
        </form>
      </Card>
    </div>
  );
}

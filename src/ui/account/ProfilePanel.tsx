'use client';

import { useState } from 'react';
import { BadgeCheck } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useI18n } from '@/i18n/client';
import { api } from '../api';
import { useApiQuery, useErrorMessage, useUnsavedChangesWarning } from '../hooks';
import { Button } from '../components/button';
import { Badge, ErrorState, LoadingState } from '../components/feedback';
import { Field, FormErrorSummary, Input, Select } from '../components/form';
import { Card } from '../components/layout';
import { useToast } from '../components/toast';

type Profile = { display_name: string; email: string | null; phone: string | null; email_verified: boolean; phone_verified: boolean; locale: 'ar' | 'en'; time_format: '12h' | '24h' };

export function ProfilePanel() {
  const q = useApiQuery<Profile>(['account-profile'], '/api/v1/account/profile');
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data) return <LoadingState rows={3} />;
  return <ProfileForm key={q.dataUpdatedAt} p={q.data} />;
}

function ProfileForm({ p }: { p: Profile }) {
  const { t } = useI18n();
  const msg = useErrorMessage();
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState({ display_name: p.display_name, locale: p.locale, time_format: p.time_format });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const dirty = f.display_name !== p.display_name || f.locale !== p.locale || f.time_format !== p.time_format;
  useUnsavedChangesWarning(dirty);
  async function save() {
    setBusy(true); setErr(null);
    try {
      await api('/api/v1/account/profile', { method: 'PATCH', body: f });
      const localeChanged = f.locale !== p.locale || f.time_format !== p.time_format;
      await qc.invalidateQueries({ queryKey: ['account-profile'] });
      toast({ tone: 'ok', text: t('account.profile.saved') });
      if (localeChanged) window.location.reload();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }
  return (
    <Card title={t('account.nav.profile')}>
      <form className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <div className="sm:col-span-2"><FormErrorSummary message={err ? msg(err) : null} /></div>
        <Field label={t('account.profile.display_name')} required className="sm:col-span-2">{(a) => <Input {...a} maxLength={120} value={f.display_name} onChange={(e) => setF({ ...f, display_name: e.target.value })} />}</Field>
        <Field label={t('account.profile.locale')}>{(a) => <Select {...a} value={f.locale} onChange={(e) => setF({ ...f, locale: e.target.value as 'ar' | 'en' })}><option value="ar">العربية</option><option value="en">English</option></Select>}</Field>
        <Field label={t('account.profile.time_format')}>{(a) => <Select {...a} value={f.time_format} onChange={(e) => setF({ ...f, time_format: e.target.value as '12h' | '24h' })}><option value="12h">{t('time.h12')}</option><option value="24h">{t('time.h24')}</option></Select>}</Field>
        <div className="flex flex-col gap-1 text-sm">
          <span className="text-xs text-ink-muted">{t('account.profile.email')}</span>
          <span dir="ltr" className="flex items-center gap-2">{p.email ?? '—'}{p.email ? <Badge tone={p.email_verified ? 'ok' : 'warn'}>{p.email_verified ? <><BadgeCheck className="size-3" aria-hidden />{t('account.profile.verified')}</> : t('account.profile.unverified')}</Badge> : null}</span>
        </div>
        <div className="flex flex-col gap-1 text-sm">
          <span className="text-xs text-ink-muted">{t('account.profile.phone')}</span>
          <span dir="ltr" className="flex items-center gap-2">{p.phone ?? '—'}{p.phone ? <Badge tone={p.phone_verified ? 'ok' : 'warn'}>{p.phone_verified ? t('account.profile.verified') : t('account.profile.unverified')}</Badge> : null}</span>
        </div>
        <div className="sm:col-span-2"><Button type="submit" loading={busy} disabled={!dirty || !f.display_name.trim()}>{t('actions.save')}</Button></div>
      </form>
    </Card>
  );
}

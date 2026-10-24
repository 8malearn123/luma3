'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Copy, KeyRound, ShieldCheck, ShieldOff } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { api } from '../api';
import { useApiQuery, useErrorMessage } from '../hooks';
import { Button } from '../components/button';
import { Alert, Badge, ErrorState, LoadingState } from '../components/feedback';
import { Field, FormErrorSummary, Input } from '../components/form';
import { Card, PageHeader } from '../components/layout';
import { useToast } from '../components/toast';
import { useStepUp } from './stepup';
import { LumaLogo } from '../components/brand';
import { safeInternalPath } from '@/shared/safe-path';
import { DeliveryNotice } from '../auth/AuthCard';

function CodeInput({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  return (
    <Field label={label} required>{(p) => (
      <Input {...p} inputMode="numeric" autoComplete="one-time-code" dir="ltr" maxLength={6} className="max-w-40 text-center font-mono text-lg tracking-[0.4em]"
        value={value} onChange={(e) => onChange(e.target.value.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/\D/g, '').slice(0, 6))} />
    )}</Field>
  );
}

/** Step 2 of enrolment: add the shown secret to an authenticator app, then confirm with a code. */
function EnrolForm({ enroll, busy, onActivate, onCancel }: { enroll: { secret: string; otpauth_uri: string }; busy: boolean; onActivate: (code: string) => void; onCancel?: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const [code, setCode] = useState('');
  return (
    <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); onActivate(code); }}>
      <ol className="list-decimal space-y-1 ps-5 text-sm">
        <li>{t('platform.security.step1')}</li>
        <li>{t('platform.security.step2')}</li>
        <li>{t('platform.security.step3')}</li>
      </ol>
      <div className="rounded-lg border border-line bg-luma-50 p-3">
        <p className="text-xs text-ink-muted">{t('platform.security.secret')}</p>
        <div className="flex items-center gap-2">
          <code dir="ltr" data-testid="mfa-secret" className="break-all font-mono text-sm tracking-wider">{enroll.secret.replace(/(.{4})/g, '$1 ').trim()}</code>
          <button type="button" aria-label={t('actions.copy')} onClick={() => navigator.clipboard?.writeText(enroll.secret).then(() => toast({ tone: 'ok', text: t('actions.copied') }))} className="rounded p-1 hover:bg-luma-100"><Copy className="size-4" /></button>
        </div>
        <details className="mt-2 text-xs"><summary className="cursor-pointer text-luma-700">{t('platform.security.uri')}</summary><code dir="ltr" className="mt-1 block break-all">{enroll.otpauth_uri}</code></details>
      </div>
      <Alert tone="info">{t('platform.security.shown_once')}</Alert>
      <CodeInput label={t('platform.mfa.code')} value={code} onChange={setCode} />
      <div className="flex gap-2">
        <Button type="submit" loading={busy} disabled={code.length !== 6}>{t('platform.security.activate')}</Button>
        {onCancel ? <Button variant="ghost" onClick={onCancel}>{t('actions.cancel')}</Button> : null}
      </div>
    </form>
  );
}

/** Session second-factor prompt (gate page: no navigation until verified). */
export function MfaPrompt({ next, demo = false }: { next: string; demo?: boolean }) {
  const { t } = useI18n();
  const msg = useErrorMessage();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [sent, setSent] = useState<{ destination?: string; delivery?: { status: string; dev_code?: string } } | null>(null);
  async function send() {
    setBusy(true); setErr(null);
    try { setSent(await api('/api/v1/platform/mfa/send', { body: {} })); } catch (e) { setErr(e); } finally { setBusy(false); }
  }
  async function submit() {
    setBusy(true); setErr(null);
    try {
      await api('/api/v1/platform/mfa/verify', { body: { code } });
      window.location.href = safeInternalPath(next, '/platform', '/platform');
    } catch (e) { setErr(e); setCode(''); setBusy(false); }
  }
  const canEnter = demo || sent;
  return (
    <div className="mx-auto flex max-w-md flex-col gap-4 py-10">
      <LumaLogo className="h-10 w-auto self-center" />
      <Card>
        <form onSubmit={(e) => { e.preventDefault(); if (code.length >= 4) submit(); }} className="flex flex-col gap-4">
          <div className="flex items-center gap-2"><KeyRound className="size-5 text-luma-700" aria-hidden /><h1 className="text-lg font-semibold">{t('platform.mfa.prompt_title')}</h1></div>
          <p className="text-sm text-ink-muted">{demo ? t('platform.mfa.demo_body') : t('platform.mfa.prompt_body')}</p>
          <FormErrorSummary message={err ? msg(err) : null} />
          {sent?.destination ? <p role="status" className="text-sm">{t('platform.mfa.sent_to', { destination: sent.destination })}</p> : null}
          <DeliveryNotice delivery={sent?.delivery} />
          {canEnter ? (
            <>
              <CodeInput label={t('platform.mfa.code')} value={code} onChange={setCode} />
              <Button type="submit" loading={busy} disabled={code.length < 4}>{t('platform.mfa.verify')}</Button>
            </>
          ) : null}
          {!demo ? (
            <Button type="button" variant={sent ? 'ghost' : 'primary'} className="self-start" loading={busy && !sent} onClick={send}>
              {sent ? t('platform.mfa.resend') : t('platform.mfa.send')}
            </Button>
          ) : null}
          {!demo ? <p className="text-xs text-ink-muted">{t('platform.mfa.lost_device')}</p> : null}
        </form>
      </Card>
    </div>
  );
}

type MfaState = { enabled: boolean; verified: boolean; pending: boolean };

/** Admin account security: TOTP enrolment, status, disable. */
export function SecurityPage() {
  const { t } = useI18n();
  const msg = useErrorMessage();
  const toast = useToast();
  const qc = useQueryClient();
  const stepUp = useStepUp();
  const q = useApiQuery<MfaState>(['platform', 'mfa'], '/api/v1/platform/mfa');
  const [enroll, setEnroll] = useState<{ secret: string; otpauth_uri: string } | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);

  if (q.isLoading) return <LoadingState />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const s = q.data!;

  async function act(fn: () => Promise<unknown>, done?: string) {
    setBusy(true); setErr(null);
    try { await fn(); if (done) toast({ tone: 'ok', text: done }); await qc.invalidateQueries({ queryKey: ['platform', 'mfa'] }); }
    catch (e) { setErr(e); } finally { setBusy(false); }
  }

  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <PageHeader title={t('platform.security.title')} subtitle={t('platform.security.subtitle')} />
      <Card title={t('platform.security.mfa')} actions={s.enabled ? <Badge tone="ok"><ShieldCheck className="size-3.5" />{t('platform.security.enabled')}</Badge> : <Badge tone="warn"><ShieldOff className="size-3.5" />{t('platform.security.disabled')}</Badge>}>
        <FormErrorSummary message={err ? msg(err) : null} />
        {!s.enabled && !enroll ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-ink-muted">{t('platform.security.explain')}</p>
            <Button className="self-start" loading={busy} icon={<KeyRound className="size-4" />} onClick={() => act(async () => {
              const r = await stepUp(() => api<{ secret: string; otpauth_uri: string }>('/api/v1/platform/mfa/enroll', { body: {} }));
              setEnroll(r); setCode('');
            })}>{t('platform.security.start')}</Button>
          </div>
        ) : null}
        {!s.enabled && enroll ? (
          <EnrolForm enroll={enroll} busy={busy} onCancel={() => setEnroll(null)}
            onActivate={(code) => act(async () => { await api('/api/v1/platform/mfa/activate', { body: { code } }); setEnroll(null); }, t('platform.security.now_enabled'))} />
        ) : null}
        {s.enabled ? (
          <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); act(() => stepUp(() => api('/api/v1/platform/mfa/disable', { body: { code } })), t('platform.security.now_disabled')); }}>
            <p className="text-sm text-ink-muted">{t('platform.security.enabled_note')}</p>
            <CodeInput label={t('platform.security.disable_code')} value={code} onChange={setCode} />
            <Button type="submit" variant="danger" className="self-start" loading={busy} disabled={code.length !== 6}>{t('platform.security.disable')}</Button>
          </form>
        ) : null}
      </Card>
    </div>
  );
}

'use client';

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { KeyRound } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { api, ApiError } from '../api';
import { useErrorMessage } from '../hooks';
import { Button } from '../components/button';
import { Dialog } from '../components/overlay';
import { Field, FormErrorSummary, Input } from '../components/form';

type Run = <T>(fn: () => Promise<T>) => Promise<T>;
const Ctx = createContext<Run | null>(null);

/**
 * Step-up for sensitive actions: if the server answers
 * `reauthentication_required`, ask for the password (POST /api/v1/auth/reauth)
 * and retry the same request once. `mfa_required` sends the admin to the MFA prompt.
 */
export function StepUpProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const msg = useErrorMessage();
  const [open, setOpen] = useState(false);
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const pending = useRef<{ resolve: () => void; reject: (e: unknown) => void } | null>(null);

  const ask = useCallback(() => new Promise<void>((resolve, reject) => {
    pending.current = { resolve, reject };
    setPw(''); setErr(null); setOpen(true);
  }), []);

  const run: Run = useCallback(async (fn) => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'mfa_required') {
        window.location.href = `/platform/mfa?next=${encodeURIComponent(window.location.pathname)}`;
        throw e;
      }
      if (!(e instanceof ApiError) || e.code !== 'reauthentication_required') throw e;
      await ask();
      return fn();
    }
  }, [ask]);

  async function submit() {
    setBusy(true); setErr(null);
    try {
      await api('/api/v1/auth/reauth', { body: { password: pw } });
      setOpen(false);
      pending.current?.resolve();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }

  function cancel() {
    setOpen(false);
    pending.current?.reject(new ApiError(401, 'reauthentication_required', t('stepup.cancelled')));
  }

  return (
    <Ctx.Provider value={run}>
      {children}
      <Dialog open={open} onClose={cancel} title={<span className="inline-flex items-center gap-2"><KeyRound className="size-5 text-luma-700" aria-hidden />{t('stepup.title')}</span>}
        footer={<><Button variant="ghost" onClick={cancel}>{t('actions.cancel')}</Button><Button loading={busy} disabled={!pw} onClick={submit}>{t('actions.confirm')}</Button></>}>
        <form onSubmit={(e) => { e.preventDefault(); if (pw) submit(); }} className="flex flex-col gap-3">
          <p className="text-ink-muted">{t('stepup.body')}</p>
          <FormErrorSummary message={err ? msg(err) : null} />
          <Field label={t('fields.password')} required>{(p) => <Input {...p} type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} />}</Field>
        </form>
      </Dialog>
    </Ctx.Provider>
  );
}

export function useStepUp(): Run {
  const c = useContext(Ctx);
  return c ?? (async (fn) => fn());
}

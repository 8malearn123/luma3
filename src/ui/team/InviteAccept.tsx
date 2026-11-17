'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useI18n } from '@/i18n/client';
import { formatDate } from '@/shared/format';
import { api } from '../api';
import { useErrorMessage } from '../hooks';
import { Button } from '../components/button';
import { Alert } from '../components/feedback';
import { FormErrorSummary } from '../components/form';
import { AuthCard } from '../auth/AuthCard';

type State = 'valid' | 'expired' | 'revoked' | 'accepted' | 'invalid';

/** Staff invitation: review → sign in (and return) → accept → dashboard. */
export function InviteAccept({ token, state, businessName, role, destination, expiresAt, user, loginHref, registerHref }: {
  token: string; state: State; businessName: string | null; role: string | null; destination: string | null; expiresAt: string | null;
  user: { name: string; matches: boolean } | null; loginHref: string; registerHref: string | null;
}) {
  const { t, locale } = useI18n();
  const msg = useErrorMessage();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [joined, setJoined] = useState<{ href: string } | null>(null);
  const roleLabel = role ? t(`roles.${role}`) : '';

  async function accept() {
    setBusy(true); setErr(null);
    try {
      const r = await api<{ tenant_slug: string; role: string }>('/api/v1/invitations/accept', { body: { token } });
      const href = r.role === 'specialist' ? '/staff' : `/app/${r.tenant_slug}`;
      setJoined({ href });
      window.location.assign(href);
    } catch (e) { setErr(e); setBusy(false); }
  }

  async function switchAccount() {
    setBusy(true);
    try { await api('/api/v1/auth/logout', { body: {} }); } finally { window.location.assign(loginHref); }
  }

  const home = <Link href="/" className="underline">{t('auth.invite_home')}</Link>;
  if (state !== 'valid') {
    const text = state === 'expired' ? t('auth.invite_expired') : state === 'revoked' ? t('auth.invite_revoked') : state === 'accepted' ? t('auth.invite_used') : t('auth.invite_invalid');
    return (
      <AuthCard title={t('auth.invite_title')} footer={home}>
        <Alert tone={state === 'invalid' ? 'danger' : 'warn'}>{text}</Alert>
        {state === 'accepted' && user ? <Link href="/app" className="mt-4 inline-block text-sm font-semibold text-luma-700 underline">{t('auth.invite_open_dashboard')}</Link> : null}
      </AuthCard>
    );
  }

  return (
    <AuthCard title={t('auth.invite_title')} footer={home}>
      <div className="flex flex-col gap-4">
        <p className="text-base leading-relaxed text-ink" data-testid="invite-intro">{t('auth.invite_intro', { business: businessName ?? '', role: roleLabel })}</p>
        <p className="text-sm text-ink-muted"><span dir="ltr">{t('auth.invite_sent_to', { destination: destination ?? '' })}</span>{expiresAt ? <> {t('auth.invite_expires', { date: formatDate(expiresAt, { locale }) })}</> : null}</p>
        <FormErrorSummary message={err ? msg(err) : null} />
        {joined ? <Alert tone="ok">{t('auth.invite_joined', { business: businessName ?? '', role: roleLabel })}</Alert> : null}
        {!user ? (
          <>
            <p className="text-sm">{t('auth.invite_signin')}</p>
            <Link href={loginHref} className="inline-flex h-12 items-center justify-center rounded-xl bg-luma-700 px-6 text-base font-medium text-white hover:bg-luma-800">{t('auth.invite_signin_cta')}</Link>
            {registerHref ? <Link href={registerHref} className="text-center text-sm text-luma-700 underline">{t('auth.invite_register_cta')}</Link> : null}
          </>
        ) : user.matches ? (
          <>
            <p className="text-sm text-ink-muted">{t('auth.invite_signed_in_as', { name: user.name })}</p>
            <Button size="lg" loading={busy} disabled={!!joined} onClick={accept}>{t('auth.invite_accept')}</Button>
          </>
        ) : (
          <>
            <Alert tone="warn">{t('auth.invite_mismatch', { destination: destination ?? '' })}</Alert>
            <p className="text-sm text-ink-muted">{t('auth.invite_signed_in_as', { name: user.name })}</p>
            <Button variant="outline" loading={busy} onClick={switchAccount}>{t('auth.invite_switch')}</Button>
          </>
        )}
      </div>
    </AuthCard>
  );
}

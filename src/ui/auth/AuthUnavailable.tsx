'use client';

import Link from 'next/link';
import { useI18n } from '@/i18n/client';
import { Alert } from '../components/feedback';
import { AuthCard } from './AuthCard';

/** Registration / recovery on a build with no messaging provider: an honest notice instead of a form. */
export function AuthUnavailable({ kind, next }: { kind: 'register' | 'recover'; next?: string }) {
  const { t } = useI18n();
  const login = next ? `/auth/login?next=${encodeURIComponent(next)}` : '/auth/login';
  return (
    <AuthCard title={t(kind === 'register' ? 'auth.register_title' : 'auth.recovery_title')} footer={<Link href={login} className="font-semibold underline">{t('auth.login_title')}</Link>}>
      <Alert tone="info" title={t('auth.unavailable_title')}>{t(kind === 'register' ? 'auth.register_unavailable' : 'auth.recovery_unavailable')}</Alert>
    </AuthCard>
  );
}

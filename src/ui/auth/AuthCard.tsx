'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { LumaLogo } from '../components/brand';
import { useI18n } from '@/i18n/client';

export function AuthCard({ title, children, footer }: { title: string; children: ReactNode; footer?: ReactNode }) {
  const { t, locale, setLocale } = useI18n();
  return (
    <div className="luma-pattern flex min-h-dvh items-center justify-center bg-gradient-to-b from-luma-100 to-luma-300/60 p-4">
      <main id="main" className="w-full max-w-md">
        <div className="mb-6 flex flex-col items-center gap-2">
          <Link href="/" aria-label="LUMA"><LumaLogo variant="vertical" className="h-28 w-auto" /></Link>
          <p className="font-serif text-sm text-luma-700" dir="ltr">{t('brand.tagline_en')}</p>
        </div>
        <div className="rounded-3xl bg-white/95 p-6 shadow-xl">
          <h1 className="mb-4 text-xl font-semibold text-luma-900">{title}</h1>
          {children}
        </div>
        {footer ? <div className="mt-4 text-center text-sm text-luma-900">{footer}</div> : null}
        <div className="mt-4 text-center">
          <button onClick={() => setLocale(locale === 'ar' ? 'en' : 'ar')} className="text-xs text-luma-800 underline">{t('locale.switch')}</button>
        </div>
      </main>
    </div>
  );
}

/** Shows exactly what happened to a verification code: simulated (dev), sent, or not sent. */
export function DeliveryNotice({ delivery }: { delivery?: { status: string; dev_code?: string } | null }) {
  const { t } = useI18n();
  if (!delivery) return null;
  if (delivery.status === 'simulated') {
    return (
      <div role="status" className="mb-4 rounded-lg border border-warn/30 bg-warn-bg p-3 text-sm text-warn">
        <p>{t('auth.dev_code_label')}</p>
        {delivery.dev_code ? <p className="mt-1 font-mono text-lg tracking-[0.3em]" dir="ltr">{delivery.dev_code}</p> : null}
      </div>
    );
  }
  if (delivery.status === 'unavailable') return <p role="alert" className="mb-4 rounded-lg bg-danger-bg p-3 text-sm text-danger">{t('auth.delivery_unavailable')}</p>;
  return null;
}

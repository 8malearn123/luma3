'use client';

import { Globe } from 'lucide-react';

/** Visitor language toggle (cookie); the storefront renders RTL for Arabic and LTR for English. */
export function LocaleSwitch({ locale, disabled }: { locale: 'ar' | 'en'; disabled?: boolean }) {
  const next = locale === 'ar' ? 'en' : 'ar';
  return (
    <button type="button" disabled={disabled} lang={next}
      onClick={() => { document.cookie = `luma_locale=${next}; path=/; max-age=31536000; samesite=lax`; window.location.reload(); }}
      className="inline-flex min-h-9 items-center gap-1 rounded-sf px-2 text-sm hover:bg-sf-primary/10 disabled:opacity-60"
      aria-label={next === 'en' ? 'English' : 'العربية'}>
      <Globe className="size-4" aria-hidden />{next === 'en' ? 'EN' : 'ع'}
    </button>
  );
}

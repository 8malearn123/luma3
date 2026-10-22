'use client';

import { Globe } from 'lucide-react';
import { useI18n } from '@/i18n/client';

export function LocaleToggle() {
  const { t, locale, setLocale } = useI18n();
  return (
    <button onClick={() => setLocale(locale === 'ar' ? 'en' : 'ar')} className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-sm hover:bg-luma-100" aria-label={t('locale.switch')}>
      <Globe className="size-4" aria-hidden />{t('locale.switch')}
    </button>
  );
}

'use client';

import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import { makeT, pick, type Locale, type T } from './index';

type Ctx = { locale: Locale; t: T; pick: (ar?: string | null, en?: string | null) => string; setLocale: (l: Locale) => void; timeFormat: '12h' | '24h' };
const I18nContext = createContext<Ctx | null>(null);

export function I18nProvider({ locale, timeFormat = '12h', children }: { locale: Locale; timeFormat?: '12h' | '24h'; children: ReactNode }) {
  const setLocale = useCallback((l: Locale) => {
    document.cookie = `luma_locale=${l}; path=/; max-age=31536000; samesite=lax`;
    window.location.reload();
  }, []);
  const value = useMemo<Ctx>(() => ({ locale, t: makeT(locale), pick: (ar, en) => pick(locale, ar, en), setLocale, timeFormat }), [locale, setLocale, timeFormat]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n outside I18nProvider');
  return ctx;
}

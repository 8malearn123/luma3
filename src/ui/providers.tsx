'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { I18nProvider } from '@/i18n/client';
import type { Locale } from '@/i18n';
import { ToastProvider } from './components/toast';
import { ApiError } from './api';

export function Providers({ locale, timeFormat, children }: { locale: Locale; timeFormat?: '12h' | '24h'; children: ReactNode }) {
  const [client] = useState(() => new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        refetchOnWindowFocus: false,
        // Never retry permission/validation errors; retry transient ones twice.
        retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
      },
      mutations: { retry: false },
    },
  }));
  return (
    <QueryClientProvider client={client}>
      <I18nProvider locale={locale} timeFormat={timeFormat}>
        <ToastProvider>{children}</ToastProvider>
      </I18nProvider>
    </QueryClientProvider>
  );
}

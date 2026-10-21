'use client';

import { useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { api, ApiError, newIdempotencyKey } from './api';
import { useI18n } from '@/i18n/client';

export function useApiQuery<T = any>(key: QueryKey, path: string | null, opts: { enabled?: boolean; refetchInterval?: number } = {}) {
  return useQuery<T, ApiError>({
    queryKey: key,
    queryFn: ({ signal }) => api<T>(path!, { signal }),
    enabled: !!path && (opts.enabled ?? true),
    refetchInterval: opts.refetchInterval,
  });
}

/**
 * Mutation with an idempotency key that stays the same across retries of the
 * same logical submission and rotates only after success — so a double click
 * or a retry after a timeout can never create two bookings or payments.
 */
export function useApiMutation<TVars = any, TRes = any>(
  fn: (vars: TVars, ctx: { idempotencyKey: string }) => Promise<TRes>,
  opts: { invalidate?: QueryKey[]; onSuccess?: (r: TRes, v: TVars) => void } = {},
) {
  const qc = useQueryClient();
  const keyRef = useRef(newIdempotencyKey());
  return useMutation<TRes, ApiError, TVars>({
    mutationFn: (vars) => fn(vars, { idempotencyKey: keyRef.current }),
    onSuccess: (r, v) => {
      keyRef.current = newIdempotencyKey();
      for (const k of opts.invalidate ?? []) qc.invalidateQueries({ queryKey: k });
      opts.onSuccess?.(r, v);
    },
  });
}

export function useErrorMessage() {
  const { t } = useI18n();
  return useCallback((err: unknown) => {
    if (!err) return '';
    if (err instanceof ApiError) {
      const k = `errors.${err.code}`;
      const msg = t(k);
      return msg === k ? err.message : msg;
    }
    return t('errors.internal_error');
  }, [t]);
}

/** Warns before leaving a page with unsaved changes (tab close / reload). */
export function useUnsavedChangesWarning(dirty: boolean) {
  const { t } = useI18n();
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = t('states.unsaved_leave'); };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty, t]);
}

export function useDebounced<T>(value: T, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => { const id = setTimeout(() => setV(value), ms); return () => clearTimeout(id); }, [value, ms]);
  return v;
}

const subscribeOnline = (cb: () => void) => {
  window.addEventListener('online', cb); window.addEventListener('offline', cb);
  return () => { window.removeEventListener('online', cb); window.removeEventListener('offline', cb); };
};

export function useOnline() {
  return useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true);
}

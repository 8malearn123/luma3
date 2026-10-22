'use client';

import type { ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Info, Loader2, Lock, SearchX, XCircle } from 'lucide-react';
import { cx } from './cx';
import { Button } from './button';
import { useI18n } from '@/i18n/client';
import { ApiError } from '../api';
import { useErrorMessage } from '../hooks';

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cx('size-5 animate-spin text-luma-500', className)} aria-hidden />;
}

export function LoadingState({ label, rows = 3 }: { label?: string; rows?: number }) {
  const { t } = useI18n();
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-3 p-4">
      <span className="sr-only">{label ?? t('states.loading')}</span>
      {Array.from({ length: rows }).map((_, i) => <div key={i} className="skeleton h-12 w-full" />)}
    </div>
  );
}

export function EmptyState({ title, hint, action, icon }: { title?: ReactNode; hint?: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-luma-200 bg-white/60 p-8 text-center">
      <div className="text-luma-300">{icon ?? <SearchX className="size-8" aria-hidden />}</div>
      <p className="font-medium">{title ?? t('states.empty')}</p>
      {hint ? <p className="max-w-md text-sm text-ink-muted">{hint}</p> : null}
      {action}
    </div>
  );
}

export function DeniedState() {
  const { t } = useI18n();
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-line bg-white p-8 text-center">
      <Lock className="size-8 text-luma-300" aria-hidden />
      <p className="font-medium">{t('states.denied')}</p>
      <p className="text-sm text-ink-muted">{t('states.denied_hint')}</p>
    </div>
  );
}

/** Error state that distinguishes permission errors from failures and offers retry. */
export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { t } = useI18n();
  const msg = useErrorMessage();
  if (error instanceof ApiError && error.status === 403) return <DeniedState />;
  return (
    <div role="alert" className="flex flex-col items-center gap-3 rounded-xl border border-danger/20 bg-danger-bg/60 p-6 text-center">
      <XCircle className="size-7 text-danger" aria-hidden />
      <p className="font-medium text-danger">{t('states.error')}</p>
      <p className="text-sm text-ink-muted">{msg(error)}</p>
      {error instanceof ApiError && error.requestId ? <p className="font-mono text-[11px] text-ink-muted" dir="ltr">ref: {error.requestId}</p> : null}
      {onRetry ? <Button variant="outline" size="sm" onClick={onRetry}>{t('actions.retry')}</Button> : null}
    </div>
  );
}

const tones = {
  info: { cls: 'border-info/20 bg-info-bg text-info', Icon: Info },
  ok: { cls: 'border-ok/20 bg-ok-bg text-ok', Icon: CheckCircle2 },
  warn: { cls: 'border-warn/20 bg-warn-bg text-warn', Icon: AlertTriangle },
  danger: { cls: 'border-danger/20 bg-danger-bg text-danger', Icon: XCircle },
};

export function Alert({ tone = 'info', title, children, className }: { tone?: keyof typeof tones; title?: ReactNode; children?: ReactNode; className?: string }) {
  const { cls, Icon } = tones[tone];
  return (
    <div role={tone === 'danger' ? 'alert' : 'status'} className={cx('flex gap-2 rounded-lg border p-3 text-sm', cls, className)}>
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div>{title ? <p className="font-medium">{title}</p> : null}{children ? <div className="text-ink/80">{children}</div> : null}</div>
    </div>
  );
}

const badgeTones: Record<string, string> = {
  neutral: 'bg-luma-100 text-luma-800', ok: 'bg-ok-bg text-ok', warn: 'bg-warn-bg text-warn', danger: 'bg-danger-bg text-danger', info: 'bg-info-bg text-info', brand: 'bg-luma-700 text-white',
};
export function Badge({ tone = 'neutral', children, className }: { tone?: keyof typeof badgeTones; children: ReactNode; className?: string }) {
  return <span className={cx('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium', badgeTones[tone], className)}>{children}</span>;
}

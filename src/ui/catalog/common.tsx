'use client';

import { DateTime } from 'luxon';
import { RefreshCw, Sparkles } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { PLAN_FEATURES } from '@/shared/plans';
import { ApiError } from '../api';
import { useErrorMessage } from '../hooks';
import { Button } from '../components/button';
import { Alert } from '../components/feedback';
import { FormErrorSummary } from '../components/form';
import { useAccess } from '../shell/access-context';

/** The tenant's plan name ("Sanaa", "Wahaj", …) in the current language. */
export function usePlanName() {
  const { t } = useI18n();
  const access = useAccess();
  const code = access.plan.code ?? '';
  const k = `platform.plan_names.${code}`;
  const v = t(k);
  return v === k ? code : v;
}

function featureLabel(key: string, locale: 'ar' | 'en') {
  const f = (PLAN_FEATURES as Record<string, { label_ar: string; label_en: string }>)[key];
  return f ? (locale === 'ar' ? f.label_ar : f.label_en) : key;
}

/**
 * Error display for forms and actions: plan limits name the plan and the limit,
 * version conflicts offer a reload, validation issues are listed.
 */
export function ApiErrorBox({ err, onReload }: { err: unknown; onReload?: () => void }) {
  const { t, locale } = useI18n();
  const msg = useErrorMessage();
  const plan = usePlanName();
  if (!err) return null;
  if (err instanceof ApiError && (err.code === 'plan_limit_reached' || err.code === 'plan_feature_unavailable')) {
    const feature = featureLabel(String(err.details?.feature ?? ''), locale);
    const limit = err.details?.limit;
    return (
      <Alert tone="warn" title={err.code === 'plan_limit_reached' ? t('catalog_team.plan.limit_title') : t('catalog_team.plan.feature_title')}>
        <p className="flex items-start gap-1.5">
          <Sparkles className="mt-0.5 size-4 shrink-0 text-luma-500" aria-hidden />
          <span>{err.code === 'plan_limit_reached'
            ? (limit ? t('catalog_team.plan.limit_body', { plan, feature, limit: String(limit) }) : t('catalog_team.plan.limit_body_zero', { plan, feature }))
            : t('catalog_team.plan.feature_body', { plan, feature })}</span>
        </p>
      </Alert>
    );
  }
  if (err instanceof ApiError && err.code === 'version_conflict') {
    return (
      <Alert tone="warn" title={t('errors.version_conflict')}>
        {onReload ? <Button size="sm" variant="outline" className="mt-2" icon={<RefreshCw className="size-4" />} onClick={onReload}>{t('actions.reload')}</Button> : null}
      </Alert>
    );
  }
  const issues = err instanceof ApiError ? (err.details?.issues as Array<{ path: string; message: string }> | undefined) : undefined;
  return <FormErrorSummary message={msg(err)} issues={issues} />;
}

/** Explains a plan-gated feature in place (the server enforces regardless). */
export function PlanGate({ feature }: { feature: string }) {
  const { t, locale } = useI18n();
  const plan = usePlanName();
  return (
    <Alert tone="info" title={t('catalog_team.plan.feature_title')}>
      {t('catalog_team.plan.feature_body', { plan, feature: featureLabel(feature, locale) })}
    </Alert>
  );
}

/** Postgres tstzrange text `["2026-11-10 03:00:00+00","…")` → instants. */
export function parseRange(during: string): { from: Date; to: Date } | null {
  const m = /^[[(]"?([^",]+)"?,"?([^")\]]+)"?[)\]]$/.exec(during.trim());
  if (!m) return null;
  const iso = (s: string) => new Date(s.trim().replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'));
  const from = iso(m[1]!), to = iso(m[2]!);
  return Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) ? null : { from, to };
}

/** "10:00:00" → "10:00". */
export const hhmm = (s: string | null | undefined) => (s ?? '').slice(0, 5);

/** A wall-clock `YYYY-MM-DDTHH:mm` in the business timezone → ISO instant with offset. */
export function localToIso(local: string, tz: string) {
  const d = DateTime.fromISO(local, { zone: tz });
  return d.isValid ? d.toISO({ suppressMilliseconds: true }) : null;
}

/** Today's local date (YYYY-MM-DD) in the business timezone. */
export function todayIn(tz: string, plusDays = 0) {
  return DateTime.now().setZone(tz).plus({ days: plusDays }).toISODate()!;
}

/** Integer from a text field (accepts Arabic-Indic digits); empty → null. */
export function intOrNull(s: string): number | null {
  const v = s.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).trim();
  if (v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

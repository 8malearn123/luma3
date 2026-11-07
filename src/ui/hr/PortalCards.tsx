'use client';

import { useState } from 'react';
import { DateTime } from 'luxon';
import { BadgeCheck, ClipboardList, Timer } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { formatTime } from '@/shared/format';
import { useApiQuery } from '../hooks';
import { Button } from '../components/button';
import { Badge, ErrorState, LoadingState } from '../components/feedback';
import { Card } from '../components/layout';
import { useAccess } from '../shell/access-context';
import { ChainSteps, DayFlagBadge, RequestStatusBadge, useDay, useDays, type Balance, type DayFlag, type HrRequest } from './common';
import { RequestForm } from './RequestForm';
import { RequestDrawer } from './RequestsTab';

type MyHr = {
  file: { employee_number: string | null; nationality: string | null; id_type: string | null; id_expiry: string | null; hire_date: string | null; documents: Array<{ id: string; title: string; expires_on: string | null }> };
  balance: Balance | null;
};

/** Staff portal: my leave balance and my (non-sensitive) staff file. */
export function MyHrCard() {
  const { t } = useI18n();
  const access = useAccess();
  const days = useDays();
  const day = useDay();
  const q = useApiQuery<MyHr>(['portal', access.slug, 'hr'], access.api('/me/hr'));
  const b = q.data?.balance;
  const f = q.data?.file;
  return (
    <Card title={<span className="inline-flex items-center gap-1"><BadgeCheck className="size-4" aria-hidden />{t('hr.portal.my_hr')}</span>}>
      {q.isLoading ? <LoadingState rows={2} /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : (
        <div className="flex flex-col gap-3 text-sm">
          {b ? (
            b.balance == null ? <p className="text-ink-muted">{t('hr.balance.unknown')}</p> : (
              <div className="rounded-xl bg-luma-50 p-3">
                <p className="text-xs text-ink-muted">{t('hr.portal.annual_balance')}</p>
                <p className="text-2xl font-semibold">{t('hr.balance.days', { n: days(b.balance) })}</p>
                <p className="text-xs text-ink-muted">{t('hr.portal.balance_detail', { accrued: days(b.accrued), taken: days(b.taken), adj: days(b.adjustments), entitlement: b.yearly_entitlement })}</p>
                {b.pending ? <p className="text-xs text-ink-muted">{t('hr.balance.pending_n', { n: days(b.pending) })}</p> : null}
                <p className="mt-1 text-xs text-ink-muted">{t('hr.portal.sick_year', { n: days(b.sick_taken_year) })}</p>
              </div>
            )
          ) : null}
          {f ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              <dt className="text-ink-muted">{t('hr.files.employee_number')}</dt><dd dir="ltr" className="text-start">{f.employee_number ?? '—'}</dd>
              <dt className="text-ink-muted">{t('hr.files.hire_date')}</dt><dd>{f.hire_date ? day(f.hire_date) : '—'}</dd>
              <dt className="text-ink-muted">{t('hr.files.nationality')}</dt><dd>{f.nationality ?? '—'}</dd>
              {f.id_type ? <><dt className="text-ink-muted">{t('hr.portal.id_expiry', { type: t(`hr.files.id_types.${f.id_type}`) })}</dt><dd>{f.id_expiry ? day(f.id_expiry) : '—'}</dd></> : null}
              {f.documents.length ? <><dt className="text-ink-muted">{t('hr.files.documents')}</dt><dd>{f.documents.map((d) => `${d.title}${d.expires_on ? ` (${day(d.expires_on)})` : ''}`).join('، ')}</dd></> : null}
            </dl>
          ) : null}
        </div>
      )}
    </Card>
  );
}

/** Staff portal: submit requests and follow them (cancel while pending). */
export function MyRequestsCard() {
  const { t, pick } = useI18n();
  const access = useAccess();
  const day = useDay();
  const q = useApiQuery<HrRequest[]>(['hr-requests', access.slug, 'mine'], access.api('/hr/requests?scope=mine'));
  const [open, setOpen] = useState<string | null>(null);
  const [form, setForm] = useState(false);
  return (
    <Card title={<span className="inline-flex items-center gap-1"><ClipboardList className="size-4" aria-hidden />{t('hr.portal.my_requests')}</span>}
      actions={!access.readOnly && !form ? <Button size="sm" onClick={() => setForm(true)}>{t('hr.request.new')}</Button> : null}>
      {form ? <div className="mb-4"><RequestForm compact onDone={() => setForm(false)} /><Button size="sm" variant="ghost" className="mt-2" onClick={() => setForm(false)}>{t('actions.cancel')}</Button></div> : null}
      {q.isLoading ? <LoadingState rows={2} /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !q.data?.length ? <p className="text-sm text-ink-muted">{t('hr.portal.no_requests')}</p> : (
        <ul className="flex flex-col gap-2">
          {q.data.slice(0, 10).map((r) => (
            <li key={r.id}>
              <button type="button" onClick={() => setOpen(r.id)} className="w-full rounded-lg border border-line p-2 text-start text-sm hover:bg-luma-50">
                <span className="flex flex-wrap items-center justify-between gap-2"><span className="font-medium">{pick(r.type_name_ar, r.type_name_en)}</span><RequestStatusBadge status={r.status} /></span>
                <span className="block text-xs text-ink-muted">{r.starts_on ? `${day(r.starts_on)}${r.ends_on && r.ends_on !== r.starts_on ? ` – ${day(r.ends_on)}` : ''}` : day(r.created_at.slice(0, 10))}</span>
                {r.status === 'pending' ? <span className="mt-1 block"><ChainSteps chain={r.approval_chain} current={r.current_step} status={r.status} /></span> : null}
              </button>
            </li>
          ))}
        </ul>
      )}
      {open ? <RequestDrawer id={open} onClose={() => setOpen(null)} /> : null}
    </Card>
  );
}

/** Staff portal: my late arrivals and absences over the last 30 days. */
export function MyLatenessCard() {
  const { t, locale, timeFormat } = useI18n();
  const access = useAccess();
  const day = useDay();
  const today = DateTime.now().setZone(access.timezone);
  const from = today.minus({ days: 30 }).toISODate()!, to = today.toISODate()!;
  const q = useApiQuery<{ grace_minutes: number; days: DayFlag[] }>(['portal', access.slug, 'lateness', from], access.api(`/hr/attendance?from=${from}&to=${to}`));
  const flagged = (q.data?.days ?? []).filter((d) => d.late_minutes > 0 || d.absent).reverse();
  return (
    <Card title={<span className="inline-flex items-center gap-1"><Timer className="size-4" aria-hidden />{t('hr.portal.lateness')}</span>}>
      {q.isLoading ? <LoadingState rows={1} /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : (
        <div className="flex flex-col gap-2 text-sm">
          <p className="text-xs text-ink-muted">{t('hr.portal.grace', { n: q.data?.grace_minutes ?? 10 })}</p>
          {!flagged.length ? <Badge tone="ok" className="self-start">{t('hr.portal.on_time')}</Badge> : (
            <ul className="flex flex-col gap-1">
              {flagged.map((d) => (
                <li key={d.date} className="flex flex-wrap items-center gap-2">
                  <span>{day(d.date)}</span>
                  <DayFlagBadge flag={d} />
                  {d.first_in ? <span dir="ltr" className="text-xs text-ink-muted">{formatTime(d.first_in, { tz: access.timezone, locale, timeFormat })}</span> : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}

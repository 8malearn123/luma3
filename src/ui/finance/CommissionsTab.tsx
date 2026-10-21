'use client';

import { useState } from 'react';
import { DateTime } from 'luxon';
import { HandCoins, Plus, Undo2 } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { api, ApiError } from '../api';
import { useApiMutation, useApiQuery, useErrorMessage } from '../hooks';
import { Button } from '../components/button';
import { Field, FormErrorSummary, Input, MoneyInput, Select } from '../components/form';
import { Alert, Badge, EmptyState, ErrorState, LoadingState } from '../components/feedback';
import { Card, DataTable, type Column } from '../components/layout';
import { ConfirmDialog, Drawer } from '../components/overlay';
import { useToast } from '../components/toast';
import { useAccess } from '../shell/access-context';
import { parseNum, useFmt } from '../commerce/common';
import { ReasonDialog, TestValueBadge } from '../engagement/shared';
import { PeriodPicker, usePeriod } from './common';

type Rule = {
  id: string; staff_id: string | null; service_id: string | null; kind: 'percent' | 'fixed'; rate_bp: number | null; amount_minor: number | null;
  effective_from: string; effective_to: string | null; is_active: boolean; staff_name: string | null; service_name_ar: string | null; service_name_en: string | null;
};
type Entry = {
  id: string; kind: 'earned' | 'reversal'; base_minor: number; amount_minor: number; reason: string | null; created_at: string; staff_name: string;
  service_name_ar: string | null; service_name_en: string | null; booking_number: string; reversed: boolean;
};

/** Precedence used by the server: staff+service > staff > service > business default. */
const level = (r: Rule) => (r.staff_id && r.service_id ? 4 : r.staff_id ? 3 : r.service_id ? 2 : 1);

export function CommissionsTab({ demo }: { demo: boolean }) {
  const { t, pick } = useI18n();
  const access = useAccess();
  const { money, when } = useFmt();
  const toast = useToast();
  const canManage = access.can('finance.manage') && !access.readOnly;
  const rules = useApiQuery<Rule[]>(['fin-rules', access.slug], access.api('/finance/commission-rules'));
  const { period, setPeriod, valid } = usePeriod('this_month');
  const entries = useApiQuery<Entry[]>(['fin-commissions', access.slug, period.from, period.to], valid ? access.api(`/finance/commissions?from=${period.from}&to=${period.to}`) : null);
  const [adding, setAdding] = useState(false);
  const [deactivating, setDeactivating] = useState<Rule | null>(null);
  const [reversing, setReversing] = useState<Entry | null>(null);
  const deactivate = useApiMutation<string>((id) => api(access.api(`/finance/commission-rules/${id}`), { method: 'DELETE' }), {
    onSuccess: () => { setDeactivating(null); rules.refetch(); toast({ tone: 'ok', text: t('fe.commissions.deactivated') }); },
  });
  const msg = useErrorMessage();

  const rate = (r: Rule) => (r.kind === 'percent' ? `${((r.rate_bp ?? 0) / 100).toFixed(r.rate_bp && r.rate_bp % 100 ? 2 : 0)}%` : money(r.amount_minor));
  const sorted = [...(rules.data ?? [])].sort((a, b) => Number(b.is_active) - Number(a.is_active) || level(b) - level(a));

  const ruleCols: Column<Rule>[] = [
    {
      key: 'scope', header: t('finance.rule_scope'), cell: (r) => (
        <div>
          <p className="font-medium">{r.staff_name ?? t('finance.all_staff')} · {r.service_id ? pick(r.service_name_ar, r.service_name_en) : t('finance.all_services')}</p>
          <p className="text-xs text-ink-muted">{t(`fe.commissions.level_${level(r)}`)}</p>
        </div>
      ),
    },
    { key: 'rate', header: t('fe.commissions.rate'), cell: (r) => <span className="inline-flex flex-wrap items-center gap-1.5"><span dir="ltr" className="font-semibold">{rate(r)}</span>{demo ? <TestValueBadge /> : null}</span> },
    { key: 'window', header: t('fe.commissions.effective'), className: 'hidden sm:table-cell', cell: (r) => <span dir="ltr" className="text-xs">{r.effective_from} → {r.effective_to ?? '…'}</span> },
    {
      key: 'status', header: t('fields.status'), cell: (r) => (
        <span className="flex flex-wrap items-center gap-2">
          <Badge tone={r.is_active ? 'ok' : 'neutral'}>{r.is_active ? t('fields.active') : t('fields.inactive')}</Badge>
          {canManage && r.is_active ? <Button size="sm" variant="ghost" onClick={() => setDeactivating(r)}>{t('fe.commissions.deactivate')}</Button> : null}
        </span>
      ),
    },
  ];
  const entryCols: Column<Entry>[] = [
    { key: 'date', header: t('fields.date'), cell: (e) => <span className="whitespace-nowrap text-xs">{when(e.created_at)}</span> },
    { key: 'staff', header: t('booking.dashboard.staff'), cell: (e) => <div><p className="font-medium">{e.staff_name}</p><p className="text-xs text-ink-muted">{pick(e.service_name_ar, e.service_name_en)} · <span dir="ltr">{e.booking_number}</span></p></div> },
    { key: 'base', header: t('fe.commissions.base'), className: 'hidden md:table-cell', cell: (e) => <span dir="ltr">{money(e.base_minor)}</span> },
    { key: 'amount', header: t('fe.common.amount'), cell: (e) => <span dir="ltr" className={e.amount_minor < 0 ? 'text-danger' : 'font-medium'}>{money(e.amount_minor)}</span> },
    {
      key: 'kind', header: t('fields.status'), cell: (e) => e.kind === 'reversal'
        ? <span className="flex flex-col gap-0.5"><Badge tone="warn">{t('fe.commissions.reversal')}</Badge>{e.reason ? <span className="max-w-40 truncate text-[11px] text-ink-muted">{e.reason}</span> : null}</span>
        : e.reversed ? <Badge tone="neutral">{t('fe.commissions.reversed')}</Badge>
          : canManage ? <Button size="sm" variant="ghost" icon={<Undo2 className="size-4" />} onClick={() => setReversing(e)}>{t('fe.commissions.reverse')}</Button>
            : <Badge tone="ok">{t('fe.commissions.earned')}</Badge>,
    },
  ];
  const sum = (entries.data ?? []).reduce((a, e) => a + e.amount_minor, 0);

  return (
    <div className="flex flex-col gap-4">
      <Card title={t('fe.commissions.rules')} actions={canManage ? <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>{t('finance.add_rule')}</Button> : null}>
        <p className="mb-3 text-xs text-ink-muted">{t('fe.commissions.precedence')}</p>
        {demo ? <Alert tone="warn" className="mb-3">{t('fe.commissions.test_values')}</Alert> : null}
        {rules.isLoading ? <LoadingState rows={2} /> : rules.error ? <ErrorState error={rules.error} onRetry={() => rules.refetch()} /> : !sorted.length ? (
          <EmptyState title={t('fe.commissions.no_rules')} hint={t('fe.commissions.no_rules_hint')} />
        ) : <DataTable rows={sorted} columns={ruleCols} rowKey={(r) => r.id} caption={t('fe.commissions.rules')} />}
      </Card>

      <Card title={t('fe.commissions.entries')}>
        <div className="mb-3"><PeriodPicker value={period} onChange={setPeriod} /></div>
        {!valid ? <Alert tone="warn">{t('fe.period.invalid')}</Alert> : entries.isLoading ? <LoadingState rows={3} /> : entries.error ? <ErrorState error={entries.error} onRetry={() => entries.refetch()} /> : !entries.data?.length ? (
          <EmptyState icon={<HandCoins className="size-8" aria-hidden />} title={t('fe.commissions.no_entries')} hint={t('fe.commissions.no_entries_hint')} />
        ) : (
          <>
            <p className="mb-2 text-sm text-ink-muted">{t('fe.commissions.net_total')}: <span dir="ltr" className="font-semibold text-ink">{money(sum)}</span></p>
            <DataTable rows={entries.data} columns={entryCols} rowKey={(e) => e.id} caption={t('fe.commissions.entries')} />
            <p className="mt-2 text-xs text-ink-muted">{t('fe.commissions.ledger_note')}</p>
          </>
        )}
      </Card>

      {adding ? <RuleDrawer onClose={() => setAdding(false)} onSaved={() => { setAdding(false); rules.refetch(); toast({ tone: 'ok', text: t('fe.commissions.rule_saved') }); }} /> : null}
      <ConfirmDialog open={!!deactivating} onClose={() => setDeactivating(null)} danger loading={deactivate.isPending} title={t('fe.commissions.deactivate_title')}
        body={<>{t('fe.commissions.deactivate_body')}{deactivate.error ? <p className="mt-2 text-danger">{msg(deactivate.error)}</p> : null}</>}
        confirmLabel={t('fe.commissions.deactivate')} onConfirm={() => deactivating && deactivate.mutate(deactivating.id)} />
      <ReasonDialog open={!!reversing} onClose={() => setReversing(null)} title={t('fe.commissions.reverse_title')} confirmLabel={t('fe.commissions.reverse')}
        body={reversing ? t('fe.commissions.reverse_body', { amount: money(reversing.amount_minor), name: reversing.staff_name }) : null}
        onConfirm={async (reason) => {
          await api(access.api(`/finance/commissions/${reversing!.id}/reverse`), { body: { reason } });
          setReversing(null); await entries.refetch(); toast({ tone: 'ok', text: t('fe.commissions.reversed_ok') });
        }} />
    </div>
  );
}

function RuleDrawer({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { t, pick } = useI18n();
  const access = useAccess();
  const msg = useErrorMessage();
  // Staff/service lists need catalogue or team access; without it, rules apply business-wide.
  const staff = useApiQuery<Array<{ id: string; display_name: string }>>(['fe-staff', access.slug], access.can('staff.edit', 'schedule.manage', 'bookings.view_all', 'bookings.manage', 'catalog.edit') ? access.api('/staff') : null);
  const services = useApiQuery<Array<{ id: string; name_ar: string | null; name_en: string | null }>>(['fe-services', access.slug], access.can('catalog.edit', 'bookings.view_all', 'bookings.manage', 'bookings.view_assigned') ? access.api('/services') : null);
  const [f, setF] = useState({ staff_id: '', service_id: '', kind: 'percent' as 'percent' | 'fixed', percent: '10', amount: null as number | null, from: DateTime.now().setZone(access.timezone).toISODate()!, to: '' });
  const [confirm, setConfirm] = useState(false);
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  const pct = parseNum(f.percent);
  const ok = f.kind === 'percent' ? pct != null && pct >= 0 && pct <= 100 : (f.amount ?? -1) >= 0;
  const save = useApiMutation<void, unknown>(() => api(access.api('/finance/commission-rules'), {
    body: {
      staff_id: f.staff_id || null, service_id: f.service_id || null, kind: f.kind,
      ...(f.kind === 'percent' ? { rate_bp: Math.round((pct ?? 0) * 100) } : { amount_minor: f.amount ?? 0 }),
      effective_from: f.from, effective_to: f.to || null,
    },
  }), { onSuccess: onSaved });
  const issues = save.error instanceof ApiError && save.error.code === 'validation_failed' ? (save.error.details?.issues as Array<{ path: string; message: string }>) : undefined;
  return (
    <Drawer open onClose={onClose} title={t('finance.add_rule')} footer={<>
      <Button variant="ghost" onClick={onClose}>{t('actions.cancel')}</Button>
      <Button disabled={!ok} loading={save.isPending} onClick={() => setConfirm(true)}>{t('actions.save')}</Button>
    </>}>
      <div className="flex flex-col gap-4">
        <FormErrorSummary message={save.error ? msg(save.error) : null} issues={issues} />
        <Field label={t('booking.dashboard.staff')} hint={staff.data ? undefined : t('fe.commissions.scope_hint')}>{(p) => (
          <Select {...p} value={f.staff_id} onChange={(e) => set({ staff_id: e.target.value })} disabled={!staff.data}>
            <option value="">{t('finance.all_staff')}</option>
            {(staff.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.display_name}</option>)}
          </Select>
        )}</Field>
        <Field label={t('booking.dashboard.services')}>{(p) => (
          <Select {...p} value={f.service_id} onChange={(e) => set({ service_id: e.target.value })} disabled={!services.data}>
            <option value="">{t('finance.all_services')}</option>
            {(services.data ?? []).map((s) => <option key={s.id} value={s.id}>{pick(s.name_ar, s.name_en)}</option>)}
          </Select>
        )}</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('fe.commissions.kind')}>{(p) => (
            <Select {...p} value={f.kind} onChange={(e) => set({ kind: e.target.value as 'percent' | 'fixed' })}>
              <option value="percent">{t('finance.percent')}</option>
              <option value="fixed">{t('finance.fixed')}</option>
            </Select>
          )}</Field>
          {f.kind === 'percent'
            ? <Field label={t('fe.commissions.percent_value')} required>{(p) => <Input {...p} inputMode="decimal" dir="ltr" value={f.percent} onChange={(e) => set({ percent: e.target.value })} />}</Field>
            : <Field label={t('fe.commissions.fixed_value')} required>{(p) => <MoneyInput {...p} value={f.amount} onChange={(m) => set({ amount: m })} />}</Field>}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('fe.commissions.effective_from')}>{(p) => <Input {...p} type="date" value={f.from} onChange={(e) => set({ from: e.target.value })} />}</Field>
          <Field label={t('fe.commissions.effective_to')} hint={t('fields.optional')}>{(p) => <Input {...p} type="date" value={f.to} min={f.from} onChange={(e) => set({ to: e.target.value })} />}</Field>
        </div>
        <p className="text-xs text-ink-muted">{t('fe.commissions.precedence')}</p>
      </div>
      <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} title={t('fe.commissions.confirm_title')} body={t('fe.commissions.confirm_body')}
        onConfirm={() => { setConfirm(false); save.mutate(); }} />
    </Drawer>
  );
}

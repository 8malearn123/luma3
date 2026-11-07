'use client';

import { useState } from 'react';
import { Plus, Save, Trash2, UserCog } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { api } from '../api';
import { useApiMutation, useApiQuery, useErrorMessage } from '../hooks';
import { Button, IconButton } from '../components/button';
import { Field, Input, MoneyInput, Select, Switch } from '../components/form';
import { Badge, ErrorState, LoadingState } from '../components/feedback';
import { Card } from '../components/layout';
import { Dialog } from '../components/overlay';
import { useToast } from '../components/toast';
import { useAccess } from '../shell/access-context';
import { parseNum } from '../commerce/common';
import { percent } from '../payroll/common';

type Tier = { threshold_minor: number; rate_bp: number };
type Policy = { enabled: boolean; rate_bp: number; tiers: Tier[] };
type Override = { staff_id: string; staff_name: string; services: Policy | null; products: Policy | null };
type Category = 'services' | 'products';

const toBp = (s: string) => { const n = parseNum(s); return n == null || n < 0 || n > 100 ? null : Math.round(n * 100); };

/** Payroll → Commission: per-staff overrides that replace the business policy for one staff member. */
export function CommissionOverridesCard() {
  const { t } = useI18n();
  const access = useAccess();
  const canManage = access.can('payroll.manage') && !access.readOnly;
  const q = useApiQuery<Override[]>(['payroll-overrides', access.slug], access.api('/payroll/commission-overrides'));
  const staff = useApiQuery<Array<{ staff_id: string; display_name: string }>>(['payroll-salaries', access.slug], access.api('/payroll/salaries'));
  const [edit, setEdit] = useState<{ staffId: string; name: string; current: Override | null } | null>(null);
  const [pick, setPick] = useState('');
  const describe = (p: Policy | null) => (!p ? t('hr.overrides.business') : !p.enabled ? t('hr.overrides.off') : `${percent(p.rate_bp)}%${p.tiers.length ? ` · ${t('hr.overrides.n_tiers', { n: p.tiers.length })}` : ''}`);
  return (
    <Card title={<span className="inline-flex items-center gap-1"><UserCog className="size-4" aria-hidden />{t('hr.overrides.title')}</span>}>
      <p className="mb-3 text-xs text-ink-muted">{t('hr.overrides.hint')}</p>
      {q.isLoading ? <LoadingState rows={2} /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : (
        <>
          {!q.data?.length ? <p className="text-sm text-ink-muted">{t('hr.overrides.none')}</p> : (
            <ul className="divide-y divide-line">
              {q.data.map((o) => (
                <li key={o.staff_id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                  <span className="font-medium">{o.staff_name}</span>
                  <Badge tone={o.services ? 'brand' : 'neutral'}>{t('hr.overrides.services')}: {describe(o.services)}</Badge>
                  <Badge tone={o.products ? 'brand' : 'neutral'}>{t('hr.overrides.products')}: {describe(o.products)}</Badge>
                  {canManage ? <Button size="sm" variant="ghost" className="ms-auto" onClick={() => setEdit({ staffId: o.staff_id, name: o.staff_name, current: o })}>{t('actions.edit')}</Button> : null}
                </li>
              ))}
            </ul>
          )}
          {canManage ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Select aria-label={t('hr.overrides.choose_staff')} className="w-56" value={pick} onChange={(e) => setPick(e.target.value)}>
                <option value="">{t('hr.overrides.choose_staff')}</option>
                {(staff.data ?? []).filter((s) => !q.data?.some((o) => o.staff_id === s.staff_id)).map((s) => <option key={s.staff_id} value={s.staff_id}>{s.display_name}</option>)}
              </Select>
              <Button size="sm" variant="outline" icon={<Plus className="size-4" />} disabled={!pick}
                onClick={() => setEdit({ staffId: pick, name: staff.data?.find((s) => s.staff_id === pick)?.display_name ?? '', current: null })}>{t('hr.overrides.add')}</Button>
            </div>
          ) : null}
        </>
      )}
      {edit ? <OverrideDialog {...edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); setPick(''); q.refetch(); }} /> : null}
    </Card>
  );
}

function OverrideDialog({ staffId, name, current, onClose, onSaved }: { staffId: string; name: string; current: Override | null; onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const access = useAccess();
  const msg = useErrorMessage();
  const toast = useToast();
  const init = (p: Policy | null | undefined) => ({ on: !!p, enabled: p?.enabled ?? true, rate: percent(p?.rate_bp ?? 0), tiers: (p?.tiers ?? []).map((x) => ({ threshold: x.threshold_minor as number | null, rate: percent(x.rate_bp) })) });
  const [state, setState] = useState<Record<Category, ReturnType<typeof init>>>({ services: init(current?.services), products: init(current?.products) });
  const build = (c: Category) => {
    const s = state[c];
    if (!s.on) return null;
    return { enabled: s.enabled, rate_bp: toBp(s.rate) ?? -1, tiers: s.tiers.map((x) => ({ threshold_minor: x.threshold ?? 0, rate_bp: toBp(x.rate) ?? -1 })) };
  };
  const body = { services: build('services'), products: build('products') };
  const valid = (['services', 'products'] as const).every((c) => {
    const b = body[c];
    return !b || (b.rate_bp >= 0 && b.tiers.every((x, i) => x.rate_bp >= 0 && x.threshold_minor > 0 && (i === 0 || x.threshold_minor > b.tiers[i - 1]!.threshold_minor)));
  });
  const m = useApiMutation(() => api(access.api(`/payroll/commission-overrides/${staffId}`), { method: 'PUT', body }), {
    invalidate: [['payroll-sheet', access.slug]], onSuccess: () => { toast({ tone: 'ok', text: t('payroll.commission.saved') }); onSaved(); },
  });
  const patch = (c: Category, p: Partial<ReturnType<typeof init>>) => setState({ ...state, [c]: { ...state[c], ...p } });
  return (
    <Dialog open onClose={onClose} title={t('hr.overrides.dialog_title', { name })} footer={<>
      <Button variant="ghost" onClick={onClose}>{t('actions.cancel')}</Button>
      <Button icon={<Save className="size-4" />} disabled={!valid} loading={m.isPending} onClick={() => m.mutate(undefined)}>{t('actions.save')}</Button>
    </>}>
      <div className="flex flex-col gap-4">
        {m.error ? <p className="text-sm text-danger">{msg(m.error)}</p> : null}
        {(['services', 'products'] as const).map((c) => {
          const s = state[c];
          return (
            <fieldset key={c} className="rounded-xl border border-line p-3">
              <legend className="px-1 text-sm font-semibold">{t(`hr.overrides.${c}`)}</legend>
              <Switch label={t('hr.overrides.use_own')} checked={s.on} onChange={(v) => patch(c, { on: v })} />
              {s.on ? (
                <div className="mt-3 flex flex-col gap-2">
                  <Switch label={t('hr.overrides.enabled')} checked={s.enabled} onChange={(v) => patch(c, { enabled: v })} />
                  <Field label={t('payroll.commission.rate')}>{(p) => <span className="flex items-center gap-1"><Input {...p} className="w-24" dir="ltr" inputMode="decimal" disabled={!s.enabled} value={s.rate} onChange={(e) => patch(c, { rate: e.target.value })} /><span className="text-ink-muted">%</span></span>}</Field>
                  {s.tiers.map((x, i) => (
                    <div key={i} className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="text-ink-muted">{t('payroll.commission.tier_from')}</span>
                      <span className="w-32"><MoneyInput aria-label={t('payroll.commission.tier_threshold', { n: i + 1 })} disabled={!s.enabled} value={x.threshold} onChange={(v) => patch(c, { tiers: s.tiers.map((y, j) => (j === i ? { ...y, threshold: v } : y)) })} /></span>
                      <span className="w-20"><Input dir="ltr" aria-label={t('payroll.commission.tier_rate_n', { n: i + 1 })} disabled={!s.enabled} value={x.rate} onChange={(e) => patch(c, { tiers: s.tiers.map((y, j) => (j === i ? { ...y, rate: e.target.value } : y)) })} /></span>
                      <span className="text-ink-muted">%</span>
                      <IconButton label={t('payroll.commission.remove_tier')} onClick={() => patch(c, { tiers: s.tiers.filter((_, j) => j !== i) })}><Trash2 className="size-4" aria-hidden /></IconButton>
                    </div>
                  ))}
                  {s.tiers.length < 10 ? <Button size="sm" variant="ghost" icon={<Plus className="size-4" />} disabled={!s.enabled} onClick={() => patch(c, { tiers: [...s.tiers, { threshold: null, rate: s.rate }] })}>{t('payroll.commission.add_tier')}</Button> : null}
                </div>
              ) : <p className="mt-1 text-xs text-ink-muted">{t('hr.overrides.uses_business')}</p>}
            </fieldset>
          );
        })}
        {!valid ? <p className="text-xs text-danger">{t('payroll.commission.tiers_invalid')}</p> : null}
      </div>
    </Dialog>
  );
}

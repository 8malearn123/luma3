'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { api } from '../../api';
import { useApiQuery, useErrorMessage } from '../../hooks';
import { Button } from '../../components/button';
import { Badge, EmptyState, ErrorState, LoadingState } from '../../components/feedback';
import { Checkbox, Field, FormErrorSummary, Input } from '../../components/form';
import { Card, DataTable } from '../../components/layout';
import { Drawer } from '../../components/overlay';
import { When } from '../common';
import { usePlatform } from '../PlatformShell';
import { useStepUp } from '../stepup';
import { bpPct } from './period';

type Founding = { enabled: boolean; total: number; taken: number; remaining: number; discount_bp: number; holders: Array<{ id: string; founding_number: number; founding_lost_at: string | null; status: string; tenant_slug: string; tenant_name: string; plan_code: string; billing_cycle: string }> };
type Promo = { id: string; code: string | null; name_ar: string; name_en: string; discount_bp: number; plan_codes: string[]; billing_cycles: string[]; starts_at: string; ends_at: string; duration_cycles: number | null; max_redemptions: number | null; redemptions: number; status: string; running: boolean; version: number };

export function FoundingCard() {
  const { t } = useI18n();
  const q = useApiQuery<Founding>(['platform', 'founding'], '/api/v1/platform/founding');
  if (q.isLoading) return <LoadingState />;
  if (q.error) return <ErrorState error={q.error} />;
  const f = q.data!;
  return (
    <Card title={t('admin.plans.founding_title')} actions={<Badge tone={f.enabled ? 'ok' : 'neutral'}>{f.enabled ? t('admin.plans.running') : t('admin.plans.disabled')}</Badge>}>
      <p className="text-sm">{t('admin.plans.founding_line', { pct: bpPct(f.discount_bp), total: f.total })}</p>
      <div className="my-3 h-2 overflow-hidden rounded-full bg-luma-100" role="progressbar" aria-valuemin={0} aria-valuemax={f.total} aria-valuenow={f.taken}>
        <div className="h-full bg-luma-600" style={{ width: `${f.total ? Math.min(100, (f.taken / f.total) * 100) : 0}%` }} />
      </div>
      <p className="text-sm text-ink-muted">{t('admin.plans.seats', { taken: f.taken, total: f.total, remaining: f.remaining })}</p>
      {f.holders.length ? (
        <details className="mt-3">
          <summary className="cursor-pointer text-sm text-luma-700">{t('admin.plans.holders')} ({f.holders.length})</summary>
          <ul className="mt-2 divide-y divide-line text-sm">
            {f.holders.map((h) => (
              <li key={h.id} className="flex justify-between gap-2 py-1.5">
                <span>#{h.founding_number} · {h.tenant_name} · {h.plan_code}/{t(`admin.plans.${h.billing_cycle}`)}</span>
                {h.founding_lost_at ? <Badge tone="danger">{t('admin.plans.lost')}</Badge> : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </Card>
  );
}

export function PromotionsCard() {
  const { t, pick } = useI18n();
  const { can } = usePlatform();
  const msg = useErrorMessage();
  const qc = useQueryClient();
  const stepUp = useStepUp();
  const q = useApiQuery<Promo[]>(['platform', 'promotions'], '/api/v1/platform/promotions');
  const [adding, setAdding] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const manage = can('platform.plans.manage');
  async function toggle(p: Promo) {
    setErr(null);
    try {
      await stepUp(() => api(`/api/v1/platform/promotions/${p.id}`, { method: 'PATCH', body: { version: p.version, status: p.status === 'active' ? 'disabled' : 'active' } }));
      await qc.invalidateQueries({ queryKey: ['platform', 'promotions'] });
    } catch (e) { setErr(e); }
  }
  return (
    <Card title={t('admin.plans.promotions')} actions={manage ? <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>{t('admin.plans.add_promotion')}</Button> : null}>
      <FormErrorSummary message={err ? msg(err) : null} />
      {q.isLoading ? <LoadingState /> : q.error ? <ErrorState error={q.error} /> : !q.data!.length ? <EmptyState title={t('admin.none')} /> : (
        <DataTable rows={q.data!} rowKey={(p) => p.id} caption={t('admin.plans.promotions')} columns={[
          { key: 'n', header: t('admin.referrals.name'), cell: (p) => pick(p.name_ar, p.name_en) },
          { key: 'c', header: t('admin.plans.promo_code'), cell: (p) => (p.code ? <span className="font-mono text-xs" dir="ltr">{p.code}</span> : <Badge tone="info">{t('admin.plans.automatic')}</Badge>) },
          { key: 'd', header: t('admin.plans.discount'), cell: (p) => `${bpPct(p.discount_bp)}%` },
          { key: 'pl', header: t('platform.plan'), className: 'hidden md:table-cell', cell: (p) => (p.plan_codes.length ? p.plan_codes.join('، ') : t('admin.plans.plans_all')) },
          { key: 'e', header: t('admin.plans.ends'), className: 'hidden md:table-cell', cell: (p) => <When v={p.ends_at} time={false} /> },
          { key: 'r', header: t('admin.plans.redemptions'), className: 'hidden sm:table-cell', cell: (p) => `${p.redemptions}${p.max_redemptions ? ` / ${p.max_redemptions}` : ''}` },
          { key: 's', header: t('fields.status'), cell: (p) => <Badge tone={p.running ? 'ok' : 'neutral'}>{p.running ? t('admin.plans.running') : p.status === 'disabled' ? t('admin.plans.disabled') : t('admin.plans.scheduled')}</Badge> },
          { key: 'x', header: '', cell: (p) => manage ? <Button size="sm" variant="ghost" onClick={() => toggle(p)}>{p.status === 'active' ? t('admin.plans.disable') : t('admin.plans.enable')}</Button> : null },
        ]} />
      )}
      {adding ? <PromotionDrawer onClose={() => setAdding(false)} /> : null}
    </Card>
  );
}

const PLAN_CODES = ['sanaa', 'wahaj', 'fareed'];

function PromotionDrawer({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const msg = useErrorMessage();
  const qc = useQueryClient();
  const stepUp = useStepUp();
  const today = new Date().toISOString().slice(0, 10);
  const [f, setF] = useState({ code: '', automatic: false, name_ar: '', name_en: '', discount: '10', plans: [] as string[], cycles: [] as string[], starts: today, ends: '', duration: '', max: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const toggle = (k: 'plans' | 'cycles', v: string) => setF({ ...f, [k]: f[k].includes(v) ? f[k].filter((x) => x !== v) : [...f[k], v] });
  async function save() {
    setBusy(true); setErr(null);
    try {
      await stepUp(() => api('/api/v1/platform/promotions', { body: {
        code: f.automatic ? null : f.code, name_ar: f.name_ar, name_en: f.name_en || f.name_ar, discount_bp: Math.round(Number(f.discount) * 100),
        plan_codes: f.plans, billing_cycles: f.cycles,
        starts_at: new Date(`${f.starts}T00:00:00+03:00`).toISOString(), ends_at: new Date(`${f.ends}T23:59:59+03:00`).toISOString(),
        duration_cycles: f.duration ? Number(f.duration) : null, max_redemptions: f.max ? Number(f.max) : null,
      } }));
      await qc.invalidateQueries({ queryKey: ['platform', 'promotions'] });
      onClose();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }
  return (
    <Drawer open onClose={onClose} title={t('admin.plans.add_promotion')}
      footer={<><Button variant="ghost" onClick={onClose}>{t('actions.cancel')}</Button><Button loading={busy} disabled={!f.name_ar || !f.ends || (!f.automatic && f.code.length < 3)} onClick={save}>{t('actions.save')}</Button></>}>
      <div className="flex flex-col gap-3">
        <FormErrorSummary message={err ? msg(err) : null} issues={(err as any)?.details?.issues} />
        <Checkbox label={t('admin.plans.automatic')} checked={f.automatic} onChange={(v) => setF({ ...f, automatic: v })} />
        {!f.automatic ? <Field label={t('admin.plans.promo_code')} required>{(p) => <Input {...p} dir="ltr" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.replace(/[^A-Za-z0-9_-]/g, '').toUpperCase() })} />}</Field> : null}
        <Field label={t('fields.name_ar')} required>{(p) => <Input {...p} dir="rtl" value={f.name_ar} onChange={(e) => setF({ ...f, name_ar: e.target.value })} />}</Field>
        <Field label={t('fields.name_en')}>{(p) => <Input {...p} dir="ltr" value={f.name_en} onChange={(e) => setF({ ...f, name_en: e.target.value })} />}</Field>
        <Field label={t('admin.plans.discount')} required>{(p) => <Input {...p} type="number" min={1} max={100} value={f.discount} onChange={(e) => setF({ ...f, discount: e.target.value })} />}</Field>
        <fieldset className="flex flex-wrap gap-3"><legend className="mb-1 w-full text-sm">{t('platform.plan')} <span className="text-xs text-ink-muted">({t('admin.plans.plans_all')})</span></legend>
          {PLAN_CODES.map((c) => <Checkbox key={c} label={c} checked={f.plans.includes(c)} onChange={() => toggle('plans', c)} />)}</fieldset>
        <fieldset className="flex flex-wrap gap-3"><legend className="mb-1 w-full text-sm">{t('pricing.billing_cycle')} <span className="text-xs text-ink-muted">({t('admin.plans.cycles_all')})</span></legend>
          {['monthly', 'yearly'].map((c) => <Checkbox key={c} label={t(`admin.plans.${c}`)} checked={f.cycles.includes(c)} onChange={() => toggle('cycles', c)} />)}</fieldset>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('admin.plans.starts')} required>{(p) => <Input {...p} type="date" value={f.starts} onChange={(e) => setF({ ...f, starts: e.target.value })} />}</Field>
          <Field label={t('admin.plans.ends')} required>{(p) => <Input {...p} type="date" value={f.ends} onChange={(e) => setF({ ...f, ends: e.target.value })} />}</Field>
          <Field label={t('admin.plans.duration')} hint={t('admin.plans.duration_hint')}>{(p) => <Input {...p} type="number" min={1} value={f.duration} onChange={(e) => setF({ ...f, duration: e.target.value })} />}</Field>
          <Field label={t('admin.plans.max_redemptions')}>{(p) => <Input {...p} type="number" min={1} value={f.max} onChange={(e) => setF({ ...f, max: e.target.value })} />}</Field>
        </div>
      </div>
    </Drawer>
  );
}

'use client';

import { useState } from 'react';
import { Gem, Pencil, Plus } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { api, ApiError } from '../api';
import { useApiMutation, useApiQuery, useErrorMessage, useUnsavedChangesWarning } from '../hooks';
import { Button } from '../components/button';
import { Checkbox, Field, FormErrorSummary, Input, MoneyInput, Select, Switch } from '../components/form';
import { Alert, Badge, EmptyState, ErrorState, LoadingState } from '../components/feedback';
import { Card, DataTable, PageHeader, Stat, type Column } from '../components/layout';
import { ConfirmDialog, Drawer } from '../components/overlay';
import { useToast } from '../components/toast';
import { useAccess } from '../shell/access-context';
import { parseNum, useFmt } from '../commerce/common';
import { CustomerPicker, type CustomerLite } from './shared';

type Tier = { code: string; name_ar: string; name_en: string; min_lifetime_points: number };
type Program = { is_enabled: boolean; points_per_currency_unit: number | string; points_expiry_days: number | null; tiers: Tier[]; reverse_on_refund: boolean; version: number };
type Reward = { id: string; name_ar: string | null; name_en: string | null; points_cost: number; kind: 'fixed_discount' | 'percent_discount'; value: number; is_active: boolean };
type Data = { program: Program; rewards: Reward[]; stats: { accounts: number; outstanding_points: number } };

export function LoyaltyPage() {
  const { t } = useI18n();
  const access = useAccess();
  const q = useApiQuery<Data>(['loyalty', access.slug], access.api('/loyalty'));
  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={t('engagement.loyalty.title')} subtitle={t('engagement.loyalty.ledger_note')} />
      {q.isLoading ? <LoadingState rows={4} /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : q.data ? (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Stat label={t('engagement.loyalty.accounts')} value={q.data.stats.accounts} />
            <Stat label={t('engagement.loyalty.outstanding')} value={q.data.stats.outstanding_points} />
          </div>
          <ProgramCard key={q.data.program.version} program={q.data.program} onSaved={() => q.refetch()} />
          <RewardsCard rewards={q.data.rewards} onChanged={() => q.refetch()} />
          <CustomerPointsCard />
        </>
      ) : null}
    </div>
  );
}

function ProgramCard({ program, onSaved }: { program: Program; onSaved: () => void }) {
  const { t, pick } = useI18n();
  const access = useAccess();
  const msg = useErrorMessage();
  const toast = useToast();
  const [f, setF] = useState({
    is_enabled: program.is_enabled, rate: String(Number(program.points_per_currency_unit)), never: program.points_expiry_days == null,
    days: String(program.points_expiry_days ?? 365), reverse: program.reverse_on_refund,
  });
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  const dirty = f.is_enabled !== program.is_enabled || Number(f.rate) !== Number(program.points_per_currency_unit) || f.never !== (program.points_expiry_days == null)
    || (!f.never && Number(f.days) !== program.points_expiry_days) || f.reverse !== program.reverse_on_refund;
  useUnsavedChangesWarning(dirty);
  const rate = parseNum(f.rate);
  const days = parseNum(f.days);
  const ok = rate != null && rate >= 0 && rate <= 100 && (f.never || (days != null && Number.isInteger(days) && days >= 30 && days <= 1825));
  const save = useApiMutation<void, unknown>(() => api(access.api('/loyalty'), {
    method: 'PUT', body: { is_enabled: f.is_enabled, points_per_currency_unit: rate, points_expiry_days: f.never ? null : days, tiers: program.tiers ?? [], reverse_on_refund: f.reverse, version: program.version },
  }), { onSuccess: () => { toast({ tone: 'ok', text: t('states.saved') }); onSaved(); } });
  const readOnly = access.readOnly;
  return (
    <Card title={t('fe.loyalty.program')}>
      <div className="flex flex-col gap-4">
        <FormErrorSummary message={save.error ? (save.error instanceof ApiError && save.error.code === 'version_conflict' ? t('fe.common.version_conflict') : msg(save.error)) : null} />
        <Switch label={t('engagement.loyalty.enabled')} checked={f.is_enabled} disabled={readOnly} onChange={(v) => set({ is_enabled: v })} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('engagement.loyalty.rate')} hint={t('fe.loyalty.rate_hint', { n: rate ?? 0 })}>{(p) => <Input {...p} inputMode="decimal" dir="ltr" disabled={readOnly} value={f.rate} onChange={(e) => set({ rate: e.target.value })} />}</Field>
          <div className="flex flex-col gap-2">
            <Field label={t('engagement.loyalty.expiry')} hint={t('fe.loyalty.expiry_hint')}>{(p) => <Input {...p} inputMode="numeric" dir="ltr" disabled={readOnly || f.never} value={f.never ? '' : f.days} onChange={(e) => set({ days: e.target.value })} />}</Field>
            <Checkbox label={t('fe.loyalty.never_expire')} checked={f.never} disabled={readOnly} onChange={(v) => set({ never: v })} />
          </div>
        </div>
        <Checkbox label={t('engagement.loyalty.reverse')} description={t('fe.loyalty.reverse_hint')} checked={f.reverse} disabled={readOnly} onChange={(v) => set({ reverse: v })} />
        {program.tiers?.length ? (
          <div>
            <p className="mb-1 text-sm font-medium">{t('fe.loyalty.tiers')}</p>
            <ul className="flex flex-wrap gap-2">{program.tiers.map((tier) => <li key={tier.code}><Badge tone="brand">{pick(tier.name_ar, tier.name_en)} · {tier.min_lifetime_points}+</Badge></li>)}</ul>
          </div>
        ) : null}
        {!readOnly ? <div className="flex justify-end"><Button disabled={!ok || !dirty} loading={save.isPending} onClick={() => save.mutate()}>{t('actions.save')}</Button></div> : null}
      </div>
    </Card>
  );
}

function RewardsCard({ rewards, onChanged }: { rewards: Reward[]; onChanged: () => void }) {
  const { t, pick } = useI18n();
  const access = useAccess();
  const { money } = useFmt();
  const toast = useToast();
  const msg = useErrorMessage();
  const [editing, setEditing] = useState<Reward | 'new' | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const canEdit = !access.readOnly;
  async function toggle(r: Reward) {
    setBusy(r.id);
    try { await api(access.api(`/loyalty/rewards/${r.id}`), { method: 'PATCH', body: { is_active: !r.is_active } }); onChanged(); }
    catch (e) { toast({ tone: 'danger', text: msg(e) }); } finally { setBusy(null); }
  }
  const value = (r: Reward) => (r.kind === 'fixed_discount' ? money(r.value) : `${r.value / 100}%`);
  const cols: Column<Reward>[] = [
    { key: 'name', header: t('fields.name'), cell: (r) => <span className="font-medium">{pick(r.name_ar, r.name_en)}</span> },
    { key: 'cost', header: t('engagement.loyalty.points_cost'), cell: (r) => <span dir="ltr">{r.points_cost}</span> },
    { key: 'value', header: t('engagement.loyalty.reward_value'), cell: (r) => <span dir="ltr">{value(r)}</span> },
    {
      key: 'status', header: t('fields.status'), cell: (r) => (
        <span className="flex flex-wrap items-center gap-1.5">
          <Badge tone={r.is_active ? 'ok' : 'neutral'}>{r.is_active ? t('fields.active') : t('fields.inactive')}</Badge>
          {canEdit ? <>
            <Button size="sm" variant="ghost" loading={busy === r.id} onClick={() => toggle(r)}>{r.is_active ? t('fe.common.deactivate') : t('fe.common.activate')}</Button>
            <Button size="sm" variant="ghost" icon={<Pencil className="size-3.5" />} onClick={() => setEditing(r)}>{t('actions.edit')}</Button>
          </> : null}
        </span>
      ),
    },
  ];
  return (
    <Card title={t('engagement.loyalty.rewards')} actions={canEdit ? <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>{t('engagement.loyalty.add_reward')}</Button> : null}>
      {!rewards.length ? <EmptyState icon={<Gem className="size-8" aria-hidden />} title={t('fe.loyalty.no_rewards')} hint={t('fe.loyalty.no_rewards_hint')} />
        : <DataTable rows={rewards} columns={cols} rowKey={(r) => r.id} caption={t('engagement.loyalty.rewards')} />}
      <p className="mt-2 text-xs text-ink-muted">{t('fe.loyalty.rewards_note')}</p>
      {editing ? <RewardDrawer reward={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); onChanged(); toast({ tone: 'ok', text: t('states.saved') }); }} /> : null}
    </Card>
  );
}

function RewardDrawer({ reward, onClose, onSaved }: { reward: Reward | null; onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const access = useAccess();
  const msg = useErrorMessage();
  const [f, setF] = useState({
    name_ar: reward?.name_ar ?? '', name_en: reward?.name_en ?? '', cost: String(reward?.points_cost ?? 100), kind: reward?.kind ?? ('fixed_discount' as Reward['kind']),
    fixed: reward?.kind === 'fixed_discount' ? reward.value : (1000 as number | null), percent: reward?.kind === 'percent_discount' ? String(reward.value / 100) : '10',
  });
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  const cost = parseNum(f.cost);
  const pct = parseNum(f.percent);
  const value = f.kind === 'fixed_discount' ? f.fixed : pct != null ? Math.round(pct * 100) : null;
  const ok = (f.name_ar.trim() || f.name_en.trim()) && cost != null && Number.isInteger(cost) && cost >= 1 && value != null && value >= 1 && (f.kind === 'fixed_discount' || value <= 10000);
  const save = useApiMutation<void, unknown>(() => {
    const body = { name_ar: f.name_ar.trim() || (reward ? null : undefined), name_en: f.name_en.trim() || (reward ? null : undefined), points_cost: cost, kind: f.kind, value };
    return reward ? api(access.api(`/loyalty/rewards/${reward.id}`), { method: 'PATCH', body }) : api(access.api('/loyalty/rewards'), { body });
  }, { onSuccess: onSaved });
  const issues = save.error instanceof ApiError && save.error.code === 'validation_failed' ? (save.error.details?.issues as Array<{ path: string; message: string }>) : undefined;
  return (
    <Drawer open onClose={onClose} title={reward ? t('fe.loyalty.edit_reward') : t('engagement.loyalty.add_reward')} footer={<>
      <Button variant="ghost" onClick={onClose}>{t('actions.cancel')}</Button>
      <Button disabled={!ok} loading={save.isPending} onClick={() => save.mutate()}>{t('actions.save')}</Button>
    </>}>
      <div className="flex flex-col gap-4">
        <FormErrorSummary message={save.error ? msg(save.error) : null} issues={issues} />
        <Field label={t('fields.name_ar')}>{(p) => <Input {...p} dir="rtl" lang="ar" maxLength={80} value={f.name_ar} onChange={(e) => set({ name_ar: e.target.value })} />}</Field>
        <Field label={t('fields.name_en')}>{(p) => <Input {...p} dir="ltr" lang="en" maxLength={80} value={f.name_en} onChange={(e) => set({ name_en: e.target.value })} />}</Field>
        <Field label={t('engagement.loyalty.points_cost')} required>{(p) => <Input {...p} inputMode="numeric" dir="ltr" value={f.cost} onChange={(e) => set({ cost: e.target.value })} />}</Field>
        <Field label={t('fe.loyalty.reward_kind')}>{(p) => (
          <Select {...p} value={f.kind} onChange={(e) => set({ kind: e.target.value as Reward['kind'] })}>
            <option value="fixed_discount">{t('fe.loyalty.fixed')}</option>
            <option value="percent_discount">{t('fe.loyalty.percent')}</option>
          </Select>
        )}</Field>
        {f.kind === 'fixed_discount'
          ? <Field label={t('engagement.loyalty.reward_value')} required>{(p) => <MoneyInput {...p} value={f.fixed} onChange={(m) => set({ fixed: m })} />}</Field>
          : <Field label={t('fe.loyalty.percent_value')} required>{(p) => <Input {...p} inputMode="decimal" dir="ltr" value={f.percent} onChange={(e) => set({ percent: e.target.value })} />}</Field>}
        <p className="text-xs text-ink-muted">{t('fe.loyalty.reward_hint')}</p>
      </div>
    </Drawer>
  );
}

type CustomerPoints = { customer: { id: string; display_name: string }; enabled: boolean; balance: number; lifetime_earned: number; tier: Tier | null; entries: Array<{ kind: string; delta: number; balance_after: number; ref_type: string; created_at: string; reason: string | null }> };

function CustomerPointsCard() {
  const { t, pick } = useI18n();
  const access = useAccess();
  const { when } = useFmt();
  const toast = useToast();
  const msg = useErrorMessage();
  const [c, setC] = useState<CustomerLite | null>(null);
  const q = useApiQuery<CustomerPoints>(['loyalty-customer', access.slug, c?.id], c ? access.api(`/loyalty/customers/${c.id}`) : null);
  const [dir, setDir] = useState<'add' | 'remove'>('add');
  const [pts, setPts] = useState('');
  const [reason, setReason] = useState('');
  const [confirm, setConfirm] = useState(false);
  const n = parseNum(pts);
  const delta = n != null && Number.isInteger(n) && n > 0 ? (dir === 'add' ? n : -n) : null;
  const adjust = useApiMutation<void, { balance: number }>(() => api(access.api('/loyalty/adjust'), { body: { customer_id: c!.id, delta, reason: reason.trim() } }), {
    onSuccess: (r) => { setConfirm(false); setPts(''); setReason(''); q.refetch(); toast({ tone: 'ok', text: t('fe.loyalty.adjusted', { n: r.balance }) }); },
  });
  const canAdjust = !access.readOnly;
  return (
    <Card title={t('fe.loyalty.lookup')}>
      <div className="flex flex-col gap-4">
        <CustomerPicker value={c} onChange={setC} />
        {c ? (q.isLoading ? <LoadingState rows={2} /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : q.data ? (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Stat label={t('fe.loyalty.balance')} value={q.data.balance} />
              <Stat label={t('fe.loyalty.lifetime')} value={q.data.lifetime_earned} />
              <Stat label={t('fe.loyalty.tier')} value={q.data.tier ? pick(q.data.tier.name_ar, q.data.tier.name_en) : '—'} />
            </div>
            {!q.data.enabled ? <Alert tone="warn">{t('fe.loyalty.disabled_note')}</Alert> : null}
            {q.data.entries.length ? (
              <ul className="flex flex-col divide-y divide-line rounded-lg border border-line text-sm">
                {q.data.entries.map((e, i) => (
                  <li key={i} className="flex items-center justify-between gap-2 px-3 py-2">
                    <span className="min-w-0"><span className="block">{t(`fe.loyalty.kinds.${e.kind}`)}{e.reason ? ` — ${e.reason}` : ''}</span><span className="text-xs text-ink-muted">{when(e.created_at)}</span></span>
                    <span dir="ltr" className={`shrink-0 font-medium ${e.delta < 0 ? 'text-danger' : 'text-ok'}`}>{e.delta > 0 ? `+${e.delta}` : e.delta}</span>
                  </li>
                ))}
              </ul>
            ) : <p className="text-sm text-ink-muted">{t('fe.loyalty.no_entries')}</p>}
            {canAdjust ? (
              <div className="flex flex-col gap-3 rounded-xl border border-line bg-luma-50 p-3">
                <p className="text-sm font-medium">{t('fe.loyalty.adjust')}</p>
                <div className="grid grid-cols-2 gap-3">
                  <Field label={t('fe.loyalty.direction')}>{(p) => (
                    <Select {...p} value={dir} onChange={(e) => setDir(e.target.value as 'add' | 'remove')}>
                      <option value="add">{t('fe.loyalty.add_points')}</option>
                      <option value="remove">{t('fe.loyalty.remove_points')}</option>
                    </Select>
                  )}</Field>
                  <Field label={t('fe.loyalty.points')} required>{(p) => <Input {...p} inputMode="numeric" dir="ltr" value={pts} onChange={(e) => setPts(e.target.value)} />}</Field>
                </div>
                <Field label={t('fields.reason')} required hint={t('fe.common.reason_hint', { n: 3 })}>{(p) => <Input {...p} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
                <div className="flex justify-end"><Button disabled={delta == null || reason.trim().length < 3} onClick={() => setConfirm(true)}>{t('fe.loyalty.adjust')}</Button></div>
              </div>
            ) : null}
          </>
        ) : null) : null}
      </div>
      <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} loading={adjust.isPending} title={t('fe.loyalty.adjust_title')}
        body={<>{c && delta != null ? t('fe.loyalty.adjust_body', { name: c.display_name, n: delta > 0 ? `+${delta}` : String(delta) }) : null}{adjust.error ? <p className="mt-2 text-danger">{msg(adjust.error)}</p> : null}</>}
        onConfirm={() => adjust.mutate()} />
    </Card>
  );
}

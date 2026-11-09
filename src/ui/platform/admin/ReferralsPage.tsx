'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Copy, Plus } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { api } from '../../api';
import { useApiQuery, useErrorMessage } from '../../hooks';
import { Button } from '../../components/button';
import { Badge, EmptyState, ErrorState, LoadingState } from '../../components/feedback';
import { Field, FormErrorSummary, Input, MoneyInput, Select } from '../../components/form';
import { Card, DataTable, PageHeader, Tabs } from '../../components/layout';
import { Dialog, Drawer } from '../../components/overlay';
import { useToast } from '../../components/toast';
import { Money, PageNav, Toolbar, When, qs } from '../common';
import { useStepUp } from '../stepup';
import { bpPct } from './period';

type Referrer = {
  id: string; kind: 'marketer' | 'business'; code: string; link: string; display_name: string; contact_phone: string | null; contact_email: string | null;
  rate_bp: number | null; effective_rate_bp: number; iban: string | null; status: string; version: number; tenant_slug: string | null;
  referred_count: number; converted_count: number; balance: number; earned: number; withdrawn: number; held: number;
};
type Overview = { items: Referrer[]; leaderboard: Referrer[]; default_rate_bp: number; min_withdrawal_minor: number };
type Withdrawal = { id: string; amount_minor: number; currency: string; iban: string; account_name: string; status: string; reject_reason: string | null; paid_reference: string | null; created_at: string; referrer_name: string; referrer_kind: string; referrer_code: string };

export function ReferralsPage() {
  const { t } = useI18n();
  const [tab, setTab] = useState<'leaderboard' | 'referrers' | 'withdrawals'>('leaderboard');
  const q = useApiQuery<Overview>(['platform', 'referrals'], '/api/v1/platform/referrals');
  const [adding, setAdding] = useState(false);
  const [edit, setEdit] = useState<Referrer | null>(null);
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={t('admin.referrals.title')} subtitle={t('admin.referrals.subtitle')}
        actions={<Button icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>{t('admin.referrals.add_marketer')}</Button>} />
      {q.data ? <p className="text-sm text-ink-muted">{t('admin.referrals.default_rate', { pct: bpPct(q.data.default_rate_bp) })}</p> : null}
      <Tabs value={tab} onChange={setTab} items={[
        { value: 'leaderboard', label: t('admin.referrals.leaderboard') }, { value: 'referrers', label: t('admin.referrals.referrers') }, { value: 'withdrawals', label: t('admin.referrals.withdrawals') },
      ]} />
      {tab === 'withdrawals' ? <WithdrawalsQueue /> : q.isLoading ? <LoadingState /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : (
        <Card>
          {!(tab === 'leaderboard' ? q.data!.leaderboard : q.data!.items).length ? <EmptyState title={t('admin.none')} /> : (
            <DataTable rows={tab === 'leaderboard' ? q.data!.leaderboard : q.data!.items} rowKey={(r) => r.id} caption={t(`admin.referrals.${tab}`)}
              onRowClick={tab === 'referrers' ? setEdit : undefined} columns={[
                ...(tab === 'leaderboard' ? [{ key: 'rank', header: '#', cell: (r: Referrer) => q.data!.leaderboard.indexOf(r) + 1 }] : []),
                { key: 'n', header: t('admin.referrals.name'), cell: (r) => <span>{r.display_name} <Badge tone={r.kind === 'marketer' ? 'info' : 'neutral'}>{t(`admin.referrals.${r.kind}`)}</Badge></span> },
                { key: 'c', header: t('admin.referrals.code'), cell: (r) => <span className="font-mono text-xs" dir="ltr">{r.code}</span> },
                { key: 'rate', header: t('admin.referrals.rate'), className: 'hidden sm:table-cell', cell: (r) => `${bpPct(r.effective_rate_bp)}%` },
                { key: 'ref', header: t('admin.referrals.referred'), cell: (r) => `${r.converted_count} / ${r.referred_count}` },
                { key: 'e', header: t('admin.referrals.earned'), cell: (r) => <Money minor={r.earned} /> },
                { key: 'b', header: t('admin.referrals.balance'), className: 'hidden md:table-cell', cell: (r) => <Money minor={r.balance} /> },
                { key: 's', header: t('admin.referrals.status'), className: 'hidden md:table-cell', cell: (r) => <Badge tone={r.status === 'active' ? 'ok' : 'danger'}>{t(`admin.referrals.${r.status}`)}</Badge> },
              ]} />
          )}
        </Card>
      )}
      {adding ? <MarketerDrawer onClose={() => setAdding(false)} /> : null}
      {edit ? <ReferrerDrawer r={edit} minMinor={q.data?.min_withdrawal_minor ?? 0} onClose={() => setEdit(null)} /> : null}
    </div>
  );
}

function MarketerDrawer({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const msg = useErrorMessage();
  const qc = useQueryClient();
  const [f, setF] = useState({ display_name: '', code: '', contact_phone: '', contact_email: '', rate: '', iban: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  async function save() {
    setBusy(true); setErr(null);
    try {
      await api('/api/v1/platform/referrals', { body: {
        display_name: f.display_name, ...(f.code ? { code: f.code } : {}), ...(f.contact_phone ? { contact_phone: f.contact_phone } : {}), ...(f.contact_email ? { contact_email: f.contact_email } : {}),
        ...(f.iban ? { iban: f.iban } : {}), rate_bp: f.rate === '' ? null : Math.round(Number(f.rate) * 100),
      } });
      await qc.invalidateQueries({ queryKey: ['platform', 'referrals'] });
      onClose();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }
  return (
    <Drawer open onClose={onClose} title={t('admin.referrals.add_marketer')}
      footer={<><Button variant="ghost" onClick={onClose}>{t('actions.cancel')}</Button><Button loading={busy} disabled={!f.display_name} onClick={save}>{t('actions.save')}</Button></>}>
      <div className="flex flex-col gap-3">
        <FormErrorSummary message={err ? msg(err) : null} issues={(err as any)?.details?.issues} />
        <Field label={t('admin.referrals.name')} required>{(p) => <Input {...p} value={f.display_name} onChange={(e) => setF({ ...f, display_name: e.target.value })} />}</Field>
        <Field label={t('admin.referrals.code')}>{(p) => <Input {...p} dir="ltr" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.replace(/[^A-Za-z0-9_-]/g, '') })} />}</Field>
        <Field label={t('admin.referrals.phone')}>{(p) => <Input {...p} dir="ltr" placeholder="+9665…" value={f.contact_phone} onChange={(e) => setF({ ...f, contact_phone: e.target.value })} />}</Field>
        <Field label={t('admin.referrals.email')}>{(p) => <Input {...p} dir="ltr" type="email" value={f.contact_email} onChange={(e) => setF({ ...f, contact_email: e.target.value })} />}</Field>
        <Field label={t('admin.referrals.rate')} hint={t('admin.referrals.rate_hint')}>{(p) => <Input {...p} type="number" min={0} max={100} step="0.5" value={f.rate} onChange={(e) => setF({ ...f, rate: e.target.value })} />}</Field>
        <Field label={t('admin.referrals.iban')}>{(p) => <Input {...p} dir="ltr" value={f.iban} onChange={(e) => setF({ ...f, iban: e.target.value })} />}</Field>
      </div>
    </Drawer>
  );
}

function ReferrerDrawer({ r, minMinor, onClose }: { r: Referrer; minMinor: number; onClose: () => void }) {
  const { t } = useI18n();
  const msg = useErrorMessage();
  const qc = useQueryClient();
  const toast = useToast();
  const stepUp = useStepUp();
  const [rate, setRate] = useState(r.rate_bp == null ? '' : String(r.rate_bp / 100));
  const [status, setStatus] = useState(r.status);
  const [w, setW] = useState({ amount: null as number | null, iban: '', account_name: r.display_name });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  async function save() {
    setBusy(true); setErr(null);
    try {
      await stepUp(() => api(`/api/v1/platform/referrals/${r.id}`, { method: 'PATCH', body: { version: r.version, rate_bp: rate === '' ? null : Math.round(Number(rate) * 100), status } }));
      await qc.invalidateQueries({ queryKey: ['platform', 'referrals'] });
      onClose();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }
  async function withdraw() {
    setBusy(true); setErr(null);
    try {
      await api(`/api/v1/platform/referrals/${r.id}/withdrawals`, { body: { amount_minor: w.amount, iban: w.iban, account_name: w.account_name } });
      toast({ tone: 'ok', text: t('states.saved') });
      await qc.invalidateQueries({ queryKey: ['platform'] });
      onClose();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }
  return (
    <Drawer open onClose={onClose} title={`${t('admin.referrals.edit')}: ${r.display_name}`}
      footer={<><Button variant="ghost" onClick={onClose}>{t('actions.cancel')}</Button><Button loading={busy} onClick={save}>{t('actions.save')}</Button></>}>
      <div className="flex flex-col gap-4">
        <FormErrorSummary message={err ? msg(err) : null} issues={(err as any)?.details?.issues} />
        <div className="flex items-center gap-2 rounded-lg bg-luma-50 p-2 text-sm">
          <span className="truncate font-mono" dir="ltr">{r.link}</span>
          <button className="ms-auto" aria-label={t('admin.referrals.copy')} onClick={() => { void navigator.clipboard?.writeText(r.link); toast({ tone: 'ok', text: t('admin.referrals.copied') }); }}><Copy className="size-4" /></button>
        </div>
        <p className="text-sm">{t('admin.referrals.balance')}: <Money minor={r.balance} /> · {t('admin.referrals.earned')}: <Money minor={r.earned} /></p>
        <Field label={t('admin.referrals.rate')} hint={t('admin.referrals.rate_hint')}>{(p) => <Input {...p} type="number" min={0} max={100} step="0.5" value={rate} onChange={(e) => setRate(e.target.value)} />}</Field>
        <Field label={t('admin.referrals.status')}>{(p) => <Select {...p} value={status} onChange={(e) => setStatus(e.target.value)}><option value="active">{t('admin.referrals.active')}</option><option value="suspended">{t('admin.referrals.suspended')}</option></Select>}</Field>
        {r.kind === 'marketer' ? (
          <fieldset className="flex flex-col gap-3 rounded-xl border border-line p-3">
            <legend className="px-1 text-sm font-medium">{t('admin.referrals.request_on_behalf')}</legend>
            <Field label={t('admin.referrals.amount')} hint={t('referral.min', { amount: (minMinor / 100).toFixed(2) })}>{(p) => <MoneyInput {...p} value={w.amount} onChange={(v) => setW({ ...w, amount: v })} />}</Field>
            <Field label={t('admin.referrals.iban')}>{(p) => <Input {...p} dir="ltr" value={w.iban} onChange={(e) => setW({ ...w, iban: e.target.value })} />}</Field>
            <Field label={t('admin.referrals.account_name')}>{(p) => <Input {...p} value={w.account_name} onChange={(e) => setW({ ...w, account_name: e.target.value })} />}</Field>
            <Button variant="outline" loading={busy} disabled={!w.amount || !w.iban} onClick={withdraw}>{t('admin.referrals.request_on_behalf')}</Button>
          </fieldset>
        ) : null}
      </div>
    </Drawer>
  );
}

function WithdrawalsQueue() {
  const { t } = useI18n();
  const [status, setStatus] = useState('requested');
  const [page, setPage] = useState(1);
  const [act, setAct] = useState<{ w: Withdrawal; action: 'approve' | 'reject' | 'mark_paid' } | null>(null);
  const path = `/api/v1/platform/withdrawals${qs({ status, page, limit: 25 })}`;
  const q = useApiQuery<{ items: Withdrawal[]; total: number }>(['platform', 'withdrawals', path], path);
  return (
    <Card>
      <Toolbar>
        <Select aria-label={t('admin.referrals.status')} className="w-auto" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
          <option value="">{t('admin.all')}</option>
          {['requested', 'approved', 'rejected', 'paid'].map((s) => <option key={s} value={s}>{t(`admin.referrals.${s}`)}</option>)}
        </Select>
      </Toolbar>
      {q.isLoading ? <LoadingState /> : q.error ? <ErrorState error={q.error} /> : !q.data!.items.length ? <EmptyState title={t('admin.none')} /> : (
        <>
          <DataTable rows={q.data!.items} rowKey={(w) => w.id} caption={t('admin.referrals.withdrawals')} columns={[
            { key: 'r', header: t('admin.referrals.name'), cell: (w) => w.referrer_name },
            { key: 'a', header: t('admin.referrals.amount'), cell: (w) => <Money minor={w.amount_minor} currency={w.currency} /> },
            { key: 'i', header: t('admin.referrals.iban'), className: 'hidden md:table-cell', cell: (w) => <span className="font-mono text-xs" dir="ltr">{w.iban}</span> },
            { key: 'n', header: t('admin.referrals.account_name'), className: 'hidden lg:table-cell', cell: (w) => w.account_name },
            { key: 'd', header: t('admin.activity.created'), className: 'hidden md:table-cell', cell: (w) => <When v={w.created_at} /> },
            { key: 's', header: t('admin.referrals.status'), cell: (w) => <Badge tone={w.status === 'paid' ? 'ok' : w.status === 'rejected' ? 'danger' : 'warn'}>{t(`admin.referrals.${w.status}`)}</Badge> },
            { key: 'x', header: '', cell: (w) => (
              <div className="flex gap-1">
                {w.status === 'requested' ? <Button size="sm" variant="outline" onClick={() => setAct({ w, action: 'approve' })}>{t('admin.referrals.approve')}</Button> : null}
                {w.status === 'approved' ? <Button size="sm" onClick={() => setAct({ w, action: 'mark_paid' })}>{t('admin.referrals.mark_paid')}</Button> : null}
                {['requested', 'approved'].includes(w.status) ? <Button size="sm" variant="ghost" onClick={() => setAct({ w, action: 'reject' })}>{t('admin.referrals.reject')}</Button> : null}
              </div>
            ) },
          ]} />
          <PageNav page={page} total={q.data!.total} limit={25} onPage={setPage} />
        </>
      )}
      {act ? <DecisionDialog {...act} onClose={() => setAct(null)} /> : null}
    </Card>
  );
}

function DecisionDialog({ w, action, onClose }: { w: Withdrawal; action: 'approve' | 'reject' | 'mark_paid'; onClose: () => void }) {
  const { t } = useI18n();
  const msg = useErrorMessage();
  const qc = useQueryClient();
  const stepUp = useStepUp();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  async function go() {
    setBusy(true); setErr(null);
    try {
      await stepUp(() => api(`/api/v1/platform/withdrawals/${w.id}`, { body: { action, ...(action === 'reject' ? { reason: text } : {}), ...(action === 'mark_paid' ? { reference: text } : {}) } }));
      await qc.invalidateQueries({ queryKey: ['platform'] });
      onClose();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }
  const needs = action === 'reject' ? 10 : action === 'mark_paid' ? 2 : 0;
  return (
    <Dialog open onClose={onClose} title={`${t(`admin.referrals.${action}`)} · ${w.referrer_name}`}
      footer={<><Button variant="ghost" onClick={onClose}>{t('actions.cancel')}</Button><Button loading={busy} disabled={text.trim().length < needs} onClick={go}>{t(`admin.referrals.${action}`)}</Button></>}>
      <div className="flex flex-col gap-3">
        <p className="text-sm"><Money minor={w.amount_minor} currency={w.currency} /> · <span dir="ltr" className="font-mono text-xs">{w.iban}</span></p>
        <FormErrorSummary message={err ? msg(err) : null} />
        {action !== 'approve' ? (
          <Field label={t(action === 'reject' ? 'admin.referrals.reject_reason' : 'admin.referrals.paid_reference')} required>
            {(p) => <Input {...p} value={text} onChange={(e) => setText(e.target.value)} />}
          </Field>
        ) : null}
      </div>
    </Dialog>
  );
}

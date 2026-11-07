'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Copy, MessageCircle, Wallet } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { formatDateTime, formatMoney } from '@/shared/format';
import { api, ApiError, tenantApi } from '../api';
import { useApiQuery, useErrorMessage } from '../hooks';
import { Button } from '../components/button';
import { Badge, EmptyState, ErrorState, LoadingState } from '../components/feedback';
import { Field, FormErrorSummary, Input, MoneyInput } from '../components/form';
import { Card, DataTable, PageHeader, Stat } from '../components/layout';
import { Dialog } from '../components/overlay';
import { useToast } from '../components/toast';
import { useAccess } from '../shell/access-context';
import { StepUpProvider, useStepUp } from '../platform/stepup';

type Overview = {
  code: string; link: string; rate_bp: number; min_withdrawal_minor: number;
  balance: { balance: number; earned: number; withdrawn: number; held: number };
  referred: Array<{ id: string; referred_name: string; status: 'pending' | 'rewarded' | 'void'; reward_minor: number | null; created_at: string }>;
  withdrawals: Array<{ id: string; amount_minor: number; currency: string; iban: string; status: string; reject_reason: string | null; created_at: string }>;
  ledger: Array<{ id: string; kind: string; amount_minor: number; created_at: string }>;
};

/** «الإحالة»: share link, referred businesses, cash balance and withdrawal requests (owner only). */
export function ReferralPage() {
  return <StepUpProvider><Referral /></StepUpProvider>;
}

function Referral() {
  const { t, locale, timeFormat } = useI18n();
  const access = useAccess();
  const toast = useToast();
  const path = tenantApi(access.slug)('/referrals');
  const q = useApiQuery<Overview>(['referrals', access.slug], path);
  const [withdraw, setWithdraw] = useState(false);
  if (q.isLoading) return <LoadingState rows={5} />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data!;
  const money = (m: number) => formatMoney(m, 'SAR', locale);
  const wa = `https://wa.me/?text=${encodeURIComponent(t('referral.whatsapp_text', { link: d.link }))}`;
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={t('referral.title')} subtitle={t('referral.subtitle', { pct: (d.rate_bp / 100).toString() })} />
      <Card title={t('referral.your_link')}>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <code className="min-w-0 flex-1 truncate rounded-lg bg-luma-50 px-3 py-2 text-sm" dir="ltr">{d.link}</code>
          <div className="flex gap-2">
            <Button variant="outline" icon={<Copy className="size-4" />} onClick={() => { void navigator.clipboard?.writeText(d.link); toast({ tone: 'ok', text: t('referral.copied') }); }}>{t('referral.copy')}</Button>
            <a href={wa} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 rounded-xl bg-[#25D366] px-3 py-2 text-sm font-medium text-white"><MessageCircle className="size-4" aria-hidden />{t('referral.share_whatsapp')}</a>
          </div>
        </div>
        <p className="mt-2 text-sm text-ink-muted">{t('referral.your_code')}: <span className="font-mono" dir="ltr">{d.code}</span></p>
      </Card>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label={t('referral.balance')} value={<span dir="ltr">{money(d.balance.balance)}</span>} tone="ok" />
        <Stat label={t('referral.earned')} value={<span dir="ltr">{money(d.balance.earned)}</span>} />
        <Stat label={t('referral.held')} value={<span dir="ltr">{money(d.balance.held)}</span>} />
        <Stat label={t('referral.withdrawn')} value={<span dir="ltr">{money(d.balance.withdrawn)}</span>} />
      </div>
      <div>
        <Button icon={<Wallet className="size-4" />} disabled={d.balance.balance < Math.max(1, d.min_withdrawal_minor)} onClick={() => setWithdraw(true)}>{t('referral.withdraw')}</Button>
        <p className="mt-1 text-xs text-ink-muted">{t('referral.min', { amount: money(d.min_withdrawal_minor) })}</p>
      </div>
      <Card title={t('referral.referred')}>
        {!d.referred.length ? <EmptyState title={t('referral.referred_empty')} /> : (
          <DataTable rows={d.referred} rowKey={(r) => r.id} caption={t('referral.referred')} columns={[
            { key: 'n', header: t('admin.tenant'), cell: (r) => r.referred_name },
            { key: 'd', header: t('admin.activity.created'), cell: (r) => formatDateTime(r.created_at, { locale, timeFormat, time: false }) },
            { key: 's', header: t('admin.referrals.status'), cell: (r) => <Badge tone={r.status === 'rewarded' ? 'ok' : 'neutral'}>{t(`referral.status.${r.status}`)}</Badge> },
            { key: 'r', header: t('referral.earned'), cell: (r) => (r.reward_minor != null ? <span dir="ltr">{money(r.reward_minor)}</span> : '—') },
          ]} />
        )}
      </Card>
      {d.withdrawals.length ? (
        <Card title={t('referral.withdrawals')}>
          <DataTable rows={d.withdrawals} rowKey={(w) => w.id} caption={t('referral.withdrawals')} columns={[
            { key: 'd', header: t('admin.activity.created'), cell: (w) => formatDateTime(w.created_at, { locale, timeFormat }) },
            { key: 'a', header: t('referral.amount'), cell: (w) => <span dir="ltr">{formatMoney(w.amount_minor, w.currency, locale)}</span> },
            { key: 'i', header: t('referral.iban'), className: 'hidden sm:table-cell', cell: (w) => <span className="font-mono text-xs" dir="ltr">{w.iban}</span> },
            { key: 's', header: t('admin.referrals.status'), cell: (w) => <span><Badge tone={w.status === 'paid' ? 'ok' : w.status === 'rejected' ? 'danger' : 'warn'}>{t(`referral.w_status.${w.status}`)}</Badge>{w.reject_reason ? <span className="block text-xs text-ink-muted">{w.reject_reason}</span> : null}</span> },
          ]} />
        </Card>
      ) : null}
      {d.ledger.length ? (
        <Card title={t('referral.ledger')}>
          <ul className="divide-y divide-line text-sm">
            {d.ledger.map((l) => (
              <li key={l.id} className="flex justify-between gap-2 py-2">
                <span>{t(`referral.ledger_kind.${l.kind}`)} <span className="text-xs text-ink-muted">· {formatDateTime(l.created_at, { locale, timeFormat })}</span></span>
                <span dir="ltr" className={l.amount_minor > 0 ? 'text-ok' : ''}>{l.amount_minor > 0 ? '+' : ''}{money(l.amount_minor)}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
      {withdraw ? <WithdrawDialog slug={access.slug} max={d.balance.balance} min={d.min_withdrawal_minor} onClose={() => setWithdraw(false)} /> : null}
    </div>
  );
}

function WithdrawDialog({ slug, max, min, onClose }: { slug: string; max: number; min: number; onClose: () => void }) {
  const { t, locale } = useI18n();
  const msg = useErrorMessage();
  const toast = useToast();
  const qc = useQueryClient();
  const stepUp = useStepUp();
  const [f, setF] = useState({ amount: max as number | null, iban: '', account_name: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  async function submit() {
    setBusy(true); setErr(null);
    try {
      await stepUp(() => api(tenantApi(slug)('/referrals/withdrawals'), { body: { amount_minor: f.amount, iban: f.iban, account_name: f.account_name } }));
      toast({ tone: 'ok', text: t('referral.requested') });
      await qc.invalidateQueries({ queryKey: ['referrals', slug] });
      onClose();
    } catch (e) {
      if (!(e instanceof ApiError && e.code === 'reauthentication_required')) setErr(e);
    } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} title={t('referral.withdraw_title')}
      footer={<><Button variant="ghost" onClick={onClose}>{t('actions.cancel')}</Button><Button loading={busy} disabled={!f.amount || !f.iban || f.account_name.length < 2} onClick={submit}>{t('referral.withdraw')}</Button></>}>
      <div className="flex flex-col gap-3">
        <FormErrorSummary message={err ? msg(err) : null} issues={(err as any)?.details?.issues} />
        <Field label={t('referral.amount')} hint={`${t('referral.min', { amount: formatMoney(min, 'SAR', locale) })} · ${t('referral.balance')}: ${formatMoney(max, 'SAR', locale)}`}>
          {(p) => <MoneyInput {...p} value={f.amount} onChange={(v) => setF({ ...f, amount: v })} />}
        </Field>
        <Field label={t('referral.iban')} required>{(p) => <Input {...p} dir="ltr" placeholder="SA00 0000 0000 0000 0000 0000" value={f.iban} onChange={(e) => setF({ ...f, iban: e.target.value })} />}</Field>
        <Field label={t('referral.account_name')} required>{(p) => <Input {...p} value={f.account_name} onChange={(e) => setF({ ...f, account_name: e.target.value })} />}</Field>
      </div>
    </Dialog>
  );
}

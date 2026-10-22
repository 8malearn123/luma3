'use client';

import { useState } from 'react';
import { BadgeCheck, Pencil, Plus, ShoppingCart, Trash2 } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { api, ApiError } from '../api';
import { useApiMutation, useApiQuery, useErrorMessage, useUnsavedChangesWarning } from '../hooks';
import { Button, IconButton } from '../components/button';
import { Field, FormErrorSummary, Input, MoneyInput, Select, Switch, Textarea } from '../components/form';
import { Alert, Badge, EmptyState, ErrorState, LoadingState } from '../components/feedback';
import { Card, PageHeader, Tabs } from '../components/layout';
import { ConfirmDialog, Drawer } from '../components/overlay';
import { useToast } from '../components/toast';
import { useAccess } from '../shell/access-context';
import { useFmt } from '../commerce/common';
import { CustomerPicker, type CustomerLite } from './shared';

type Plan = {
  id: string; name_ar: string | null; name_en: string | null; description_ar: string | null; description_en: string | null; price_minor: number; validity_days: number;
  is_active: boolean; is_visible: boolean; items: Array<{ service_id: string; sessions: number }>;
};
type Service = { id: string; name_ar: string | null; name_en: string | null; archived_at: string | null };
type Membership = {
  id: string; status: string; starts_at: string | null; ends_at: string | null; price_paid_minor: number; customer_name: string; tenant_customer_id: string; created_at: string;
  plan_snapshot: { name_ar?: string | null; name_en?: string | null; validity_days?: number };
  entitlements: Array<{ id: string; service_id: string; total: number; used: number; reserved: number; remaining: number }>;
};

function useServiceNames() {
  const access = useAccess();
  const { pick } = useI18n();
  const q = useApiQuery<Service[]>(['fe-services', access.slug], access.can('catalog.edit', 'bookings.view_all', 'bookings.manage', 'bookings.view_assigned') ? access.api('/services') : null);
  return { services: (q.data ?? []).filter((s) => !s.archived_at), name: (id: string) => { const s = q.data?.find((x) => x.id === id); return s ? pick(s.name_ar, s.name_en) : '—'; } };
}

export function MembershipsPage() {
  const { t } = useI18n();
  const [tab, setTab] = useState<'plans' | 'sell' | 'customers'>('plans');
  const access = useAccess();
  const canManage = access.can('memberships.manage') && !access.readOnly;
  return (
    <div>
      <PageHeader title={t('engagement.memberships.title')} subtitle={t('fe.memberships.subtitle')} />
      <Tabs value={tab} onChange={setTab} items={[
        { value: 'plans', label: t('fe.memberships.plans') },
        ...(canManage ? [{ value: 'sell' as const, label: t('engagement.memberships.sell') }] : []),
        { value: 'customers', label: t('fe.memberships.customer_memberships') },
      ]} />
      {tab === 'plans' ? <PlansTab canManage={canManage} /> : tab === 'sell' && canManage ? <SellTab onSold={() => setTab('customers')} /> : <CustomerMembershipsTab />}
    </div>
  );
}

function PlansTab({ canManage }: { canManage: boolean }) {
  const { t, pick } = useI18n();
  const access = useAccess();
  const { money } = useFmt();
  const toast = useToast();
  const msg = useErrorMessage();
  const plans = useApiQuery<Plan[]>(['membership-plans', access.slug], access.api('/membership-plans'));
  const { name } = useServiceNames();
  const [editing, setEditing] = useState<Plan | 'new' | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  async function patch(p: Plan, body: Partial<Plan>) {
    setBusy(p.id);
    try { await api(access.api(`/membership-plans/${p.id}`), { method: 'PATCH', body }); await plans.refetch(); }
    catch (e) { toast({ tone: 'danger', text: msg(e) }); } finally { setBusy(null); }
  }
  return (
    <div className="flex flex-col gap-3">
      {canManage ? <div className="flex justify-end"><Button icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>{t('engagement.memberships.new_plan')}</Button></div> : null}
      {plans.isLoading ? <LoadingState rows={3} /> : plans.error ? <ErrorState error={plans.error} onRetry={() => plans.refetch()} /> : !plans.data?.length ? (
        <EmptyState icon={<BadgeCheck className="size-8" aria-hidden />} title={t('fe.memberships.no_plans')} hint={canManage ? t('fe.memberships.no_plans_hint') : undefined} />
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {plans.data.map((p) => (
            <li key={p.id} className="flex flex-col rounded-2xl border border-line bg-white p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-semibold text-luma-900">{pick(p.name_ar, p.name_en)}</p>
                  <p className="text-sm"><span dir="ltr" className="font-medium">{money(p.price_minor)}</span> · {t('fe.memberships.valid_for', { n: p.validity_days })}</p>
                </div>
                <span className="flex flex-wrap justify-end gap-1">
                  <Badge tone={p.is_active ? 'ok' : 'neutral'}>{p.is_active ? t('fields.active') : t('fields.inactive')}</Badge>
                  {!p.is_visible ? <Badge tone="neutral">{t('fields.hidden')}</Badge> : null}
                </span>
              </div>
              {pick(p.description_ar, p.description_en) ? <p className="mt-1 text-xs text-ink-muted">{pick(p.description_ar, p.description_en)}</p> : null}
              <p className="mt-3 text-xs font-medium text-ink-muted">{t('engagement.memberships.plan_items')}</p>
              <ul className="mt-1 text-sm">{p.items.map((i) => <li key={i.service_id} className="flex justify-between gap-2"><span>{name(i.service_id)}</span><span dir="ltr">× {i.sessions}</span></li>)}</ul>
              {canManage ? (
                <div className="mt-3 flex flex-wrap gap-1 border-t border-line pt-3">
                  <Button size="sm" variant="ghost" icon={<Pencil className="size-3.5" />} onClick={() => setEditing(p)}>{t('actions.edit')}</Button>
                  <Button size="sm" variant="ghost" loading={busy === p.id} onClick={() => patch(p, { is_active: !p.is_active })}>{p.is_active ? t('fe.common.deactivate') : t('fe.common.activate')}</Button>
                  <Button size="sm" variant="ghost" disabled={busy === p.id} onClick={() => patch(p, { is_visible: !p.is_visible })}>{p.is_visible ? t('fe.memberships.hide_store') : t('fe.memberships.show_store')}</Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-ink-muted">{t('fe.memberships.snapshot_note')}</p>
      {editing ? <PlanDrawer plan={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); plans.refetch(); toast({ tone: 'ok', text: t('states.saved') }); }} /> : null}
    </div>
  );
}

function PlanDrawer({ plan, onClose, onSaved }: { plan: Plan | null; onClose: () => void; onSaved: () => void }) {
  const { t, pick } = useI18n();
  const access = useAccess();
  const msg = useErrorMessage();
  const { services, name } = useServiceNames();
  const [f, setF] = useState({
    name_ar: plan?.name_ar ?? '', name_en: plan?.name_en ?? '', description_ar: plan?.description_ar ?? '', description_en: plan?.description_en ?? '',
    price: (plan?.price_minor ?? null) as number | null, validity: String(plan?.validity_days ?? 90), is_visible: plan?.is_visible ?? true,
    items: (plan?.items ?? [{ service_id: '', sessions: 4 }]).map((i) => ({ service_id: i.service_id, sessions: String(i.sessions) })),
  });
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  useUnsavedChangesWarning(!plan && (!!f.name_ar || !!f.name_en));
  const validity = Number(f.validity);
  const itemsOk = f.items.length > 0 && f.items.every((i) => i.service_id && Number(i.sessions) >= 1 && Number(i.sessions) <= 500) && new Set(f.items.map((i) => i.service_id)).size === f.items.length;
  const ok = (f.name_ar.trim() || f.name_en.trim()) && f.price != null && Number.isInteger(validity) && validity >= 1 && validity <= 1095 && (plan || itemsOk);
  const save = useApiMutation<void, unknown>(() => {
    const base = {
      name_ar: f.name_ar.trim() || undefined, name_en: f.name_en.trim() || undefined, description_ar: f.description_ar.trim() || undefined, description_en: f.description_en.trim() || undefined,
      price_minor: f.price, validity_days: validity, is_visible: f.is_visible,
    };
    if (plan) {
      const nul = (v: string) => v.trim() || null;
      return api(access.api(`/membership-plans/${plan.id}`), { method: 'PATCH', body: { ...base, name_ar: nul(f.name_ar), name_en: nul(f.name_en), description_ar: nul(f.description_ar), description_en: nul(f.description_en) } });
    }
    return api(access.api('/membership-plans'), { body: { ...base, items: f.items.map((i) => ({ service_id: i.service_id, sessions: Number(i.sessions) })) } });
  }, { onSuccess: onSaved });
  const issues = save.error instanceof ApiError && save.error.code === 'validation_failed' ? (save.error.details?.issues as Array<{ path: string; message: string }>) : undefined;
  return (
    <Drawer open onClose={onClose} title={plan ? t('fe.memberships.edit_plan') : t('engagement.memberships.new_plan')} footer={<>
      <Button variant="ghost" onClick={onClose}>{t('actions.cancel')}</Button>
      <Button disabled={!ok} loading={save.isPending} onClick={() => save.mutate()}>{t('actions.save')}</Button>
    </>}>
      <div className="flex flex-col gap-4">
        <FormErrorSummary message={save.error ? msg(save.error) : null} issues={issues} />
        <Field label={t('fields.name_ar')}>{(p) => <Input {...p} dir="rtl" lang="ar" maxLength={120} value={f.name_ar} onChange={(e) => set({ name_ar: e.target.value })} />}</Field>
        <Field label={t('fields.name_en')}>{(p) => <Input {...p} dir="ltr" lang="en" maxLength={120} value={f.name_en} onChange={(e) => set({ name_en: e.target.value })} />}</Field>
        <Field label={t('fe.memberships.description_ar')} hint={t('fields.optional')}>{(p) => <Textarea {...p} dir="rtl" maxLength={1000} value={f.description_ar} onChange={(e) => set({ description_ar: e.target.value })} />}</Field>
        <Field label={t('fe.memberships.description_en')} hint={t('fields.optional')}>{(p) => <Textarea {...p} dir="ltr" maxLength={1000} value={f.description_en} onChange={(e) => set({ description_en: e.target.value })} />}</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('fields.price')} required>{(p) => <MoneyInput {...p} value={f.price} onChange={(m) => set({ price: m })} />}</Field>
          <Field label={t('engagement.memberships.validity')} required>{(p) => <Input {...p} inputMode="numeric" dir="ltr" value={f.validity} onChange={(e) => set({ validity: e.target.value.replace(/[^0-9]/g, '') })} />}</Field>
        </div>
        <Switch label={t('fe.memberships.visible_store')} checked={f.is_visible} onChange={(v) => set({ is_visible: v })} />
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">{t('engagement.memberships.plan_items')}</legend>
          {plan ? (
            <>
              <ul className="text-sm">{plan.items.map((i) => <li key={i.service_id} className="flex justify-between"><span>{name(i.service_id)}</span><span dir="ltr">× {i.sessions}</span></li>)}</ul>
              <p className="text-xs text-ink-muted">{t('fe.memberships.items_fixed')}</p>
            </>
          ) : (
            <>
              {f.items.map((it, idx) => (
                <div key={idx} className="flex items-end gap-2">
                  <Field label={t('fe.groups.service')} className="min-w-0 flex-1">{(p) => (
                    <Select {...p} value={it.service_id} onChange={(e) => set({ items: f.items.map((x, j) => (j === idx ? { ...x, service_id: e.target.value } : x)) })}>
                      <option value="">{t('fe.common.choose')}</option>
                      {services.map((s) => <option key={s.id} value={s.id} disabled={f.items.some((x, j) => j !== idx && x.service_id === s.id)}>{pick(s.name_ar, s.name_en)}</option>)}
                    </Select>
                  )}</Field>
                  <Field label={t('engagement.memberships.sessions')} className="w-24">{(p) => <Input {...p} inputMode="numeric" dir="ltr" value={it.sessions} onChange={(e) => set({ items: f.items.map((x, j) => (j === idx ? { ...x, sessions: e.target.value.replace(/[^0-9]/g, '') } : x)) })} />}</Field>
                  <IconButton label={t('actions.delete')} disabled={f.items.length === 1} onClick={() => set({ items: f.items.filter((_, j) => j !== idx) })}><Trash2 className="size-4" /></IconButton>
                </div>
              ))}
              <Button size="sm" variant="outline" className="self-start" icon={<Plus className="size-4" />} disabled={f.items.length >= 20} onClick={() => set({ items: [...f.items, { service_id: '', sessions: '1' }] })}>{t('fe.memberships.add_service')}</Button>
              {!services.length ? <Alert tone="warn">{t('fe.memberships.no_services')}</Alert> : null}
            </>
          )}
        </fieldset>
      </div>
    </Drawer>
  );
}

function SellTab({ onSold }: { onSold: () => void }) {
  const { t, pick } = useI18n();
  const access = useAccess();
  const { money } = useFmt();
  const msg = useErrorMessage();
  const toast = useToast();
  const plans = useApiQuery<Plan[]>(['membership-plans', access.slug], access.api('/membership-plans'));
  const active = (plans.data ?? []).filter((p) => p.is_active);
  const [c, setC] = useState<CustomerLite | null>(null);
  const [planId, setPlanId] = useState('');
  const [method, setMethod] = useState<'cash' | 'pos_terminal'>('cash');
  const [reference, setReference] = useState('');
  const [confirm, setConfirm] = useState(false);
  const plan = active.find((p) => p.id === planId);
  const sell = useApiMutation<void, unknown>((_v, { idempotencyKey }) => api(access.api('/memberships'), { idempotencyKey, body: { customer_id: c!.id, plan_id: planId, method, reference: reference.trim() } }), {
    onSuccess: () => { setConfirm(false); toast({ tone: 'ok', text: t('fe.memberships.sold') }); onSold(); },
  });
  const ok = !!c && !!plan && reference.trim().length >= 2;
  if (plans.isLoading) return <LoadingState rows={3} />;
  if (plans.error) return <ErrorState error={plans.error} onRetry={() => plans.refetch()} />;
  if (!active.length) return <EmptyState icon={<BadgeCheck className="size-8" aria-hidden />} title={t('fe.memberships.no_active_plans')} />;
  return (
    <Card title={t('engagement.memberships.sell')}>
      <div className="flex max-w-xl flex-col gap-4">
        <CustomerPicker value={c} onChange={setC} />
        <Field label={t('fe.memberships.plan')} required>{(p) => (
          <Select {...p} value={planId} onChange={(e) => setPlanId(e.target.value)}>
            <option value="">{t('fe.common.choose')}</option>
            {active.map((pl) => <option key={pl.id} value={pl.id}>{pick(pl.name_ar, pl.name_en)} — {money(pl.price_minor)}</option>)}
          </Select>
        )}</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('booking.dashboard.method')}>{(p) => (
            <Select {...p} value={method} onChange={(e) => setMethod(e.target.value as 'cash' | 'pos_terminal')}>
              <option value="cash">{t('booking.dashboard.cash')}</option>
              <option value="pos_terminal">{t('booking.dashboard.pos')}</option>
            </Select>
          )}</Field>
          <Field label={t('booking.dashboard.reference')} required>{(p) => <Input {...p} dir="ltr" maxLength={80} value={reference} onChange={(e) => setReference(e.target.value)} />}</Field>
        </div>
        <p className="text-xs text-ink-muted">{t('fe.memberships.sell_note')}</p>
        <FormErrorSummary message={sell.error ? msg(sell.error) : null} />
        <div className="flex justify-end"><Button icon={<ShoppingCart className="size-4" />} disabled={!ok} loading={sell.isPending} onClick={() => setConfirm(true)}>{t('engagement.memberships.sell')}</Button></div>
      </div>
      <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} loading={sell.isPending} title={t('fe.memberships.sell_confirm_title')}
        body={plan && c ? t('fe.memberships.sell_confirm_body', { plan: pick(plan.name_ar, plan.name_en), name: c.display_name, amount: money(plan.price_minor), method: method === 'cash' ? t('booking.dashboard.cash') : t('booking.dashboard.pos') }) : null}
        onConfirm={() => sell.mutate()} />
    </Card>
  );
}

function CustomerMembershipsTab() {
  const { t, pick } = useI18n();
  const access = useAccess();
  const { money, when } = useFmt();
  const { name } = useServiceNames();
  const [c, setC] = useState<CustomerLite | null>(null);
  const q = useApiQuery<Membership[]>(['memberships', access.slug, c?.id ?? 'recent'], access.api(`/memberships${c ? `?customer_id=${c.id}` : ''}`));
  const tone = (s: string) => (s === 'active' ? 'ok' : s === 'pending_payment' ? 'warn' : 'neutral');
  return (
    <div className="flex flex-col gap-3">
      <div className="max-w-md"><CustomerPicker value={c} onChange={setC} label={t('fe.memberships.filter_customer')} /></div>
      {!c ? <p className="text-xs text-ink-muted">{t('fe.memberships.recent')}</p> : null}
      {q.isLoading ? <LoadingState rows={3} /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !q.data?.length ? (
        <EmptyState icon={<BadgeCheck className="size-8" aria-hidden />} title={t('fe.memberships.no_memberships')} />
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {q.data.map((m) => (
            <li key={m.id} className="rounded-2xl border border-line bg-white p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-semibold text-luma-900">{m.customer_name}</p>
                  <p className="text-sm">{pick(m.plan_snapshot.name_ar, m.plan_snapshot.name_en)} · <span dir="ltr">{money(m.price_paid_minor)}</span></p>
                  <p className="text-xs text-ink-muted">{m.ends_at ? t('fe.memberships.valid_until', { date: when(m.ends_at) }) : '—'}</p>
                </div>
                <Badge tone={tone(m.status)}>{t(`fe.memberships.status.${m.status}`)}</Badge>
              </div>
              <table className="mt-3 w-full text-sm">
                <caption className="sr-only">{t('engagement.memberships.remaining')}</caption>
                <thead><tr className="text-xs text-ink-muted"><th scope="col" className="text-start font-normal">{t('fe.groups.service')}</th><th scope="col" className="text-end font-normal">{t('engagement.memberships.remaining')}</th></tr></thead>
                <tbody>
                  {m.entitlements.map((e) => (
                    <tr key={e.id} className="border-t border-line">
                      <td className="py-1">{name(e.service_id)}</td>
                      <td className="py-1 text-end" dir="ltr"><span className="font-semibold">{e.remaining}</span> / {e.total}{e.reserved ? <span className="ms-1 text-xs text-ink-muted">({t('fe.memberships.reserved', { n: e.reserved })})</span> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useI18n } from '@/i18n/client';
import { api } from '../../api';
import { useApiQuery, useErrorMessage } from '../../hooks';
import { Button } from '../../components/button';
import { Badge, EmptyState, ErrorState, LoadingState } from '../../components/feedback';
import { Field, Input, Select } from '../../components/form';
import { Card } from '../../components/layout';
import { useToast } from '../../components/toast';
import { useStepUp } from '../stepup';
import { LoomConnectionsPanel, LoomWebhooksPanel } from '../../marketing/LoomConnections';

/**
 * /platform/loom — businesses outside LUMA (Loom-only). The platform owner
 * creates them (enabled sector packs only), connects their data, reviews the
 * first snapshot and runs analyses. Self-serve sign-in for external users is
 * future work (docs/LOOM_CORE.md §11).
 */
const BASE = '/api/v1/platform/loom/businesses';

export function LoomExternalBusinesses() {
  const { t } = useI18n();
  const msg = useErrorMessage();
  const toast = useToast();
  const qc = useQueryClient();
  const stepUp = useStepUp();
  const q = useApiQuery<any>(['platform', 'loom-external'], BASE);
  const [open, setOpen] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', sector_pack: '', timezone: 'Asia/Riyadh', currency: 'SAR' });
  if (q.isLoading) return <LoadingState rows={3} />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const { businesses, packs } = q.data;
  const enabled = packs.filter((p: any) => p.enabled);
  async function create() {
    try {
      const b = await stepUp(() => api<any>(BASE, { method: 'POST', body: { ...form, sector_pack: form.sector_pack || enabled[0]?.id } }));
      toast({ tone: 'ok', text: t('states.saved') });
      await qc.invalidateQueries({ queryKey: ['platform', 'loom-external'] });
      setForm({ ...form, name: '' });
      setOpen(b.id);
    } catch (e) { toast({ tone: 'danger', text: msg(e) }); }
  }
  if (open) return <ExternalDetail id={open} onBack={() => setOpen(null)} />;
  return (
    <Card title={t('loomc.external.title')}>
      <p className="mb-3 text-sm text-ink-muted">{t('loomc.external.subtitle')}</p>
      {businesses.length ? (
        <ul className="flex flex-col gap-2">
          {businesses.map((b: any) => (
            <li key={b.id} className="flex flex-wrap items-center justify-between gap-2 rounded border border-line p-2">
              <span className="flex flex-wrap items-center gap-2"><strong dir="auto">{b.name}</strong><Badge>{packs.find((p: any) => p.id === b.sector_pack)?.label ?? b.sector_pack}</Badge>
                {b.connections.map((c: any) => <Badge key={c.id} tone={c.review_status === 'approved' ? 'ok' : 'warn'}>{t(`loomc.kind.${c.kind}`)} · {t(`loomc.review.${c.review_status}`)}</Badge>)}
                {b.last_analysis ? <Badge tone={b.last_analysis.status === 'succeeded' ? 'ok' : 'warn'}>{b.last_analysis.status}</Badge> : null}</span>
              <Button size="sm" variant="ghost" onClick={() => setOpen(b.id)}>{t('loomc.actions.open')}</Button>
            </li>
          ))}
        </ul>
      ) : <EmptyState title={t('loomc.external.empty')} />}
      <div className="mt-4 grid gap-3 border-t border-line pt-3 md:grid-cols-2">
        <Field label={t('loomc.external.name')} required>{(p) => <Input {...p} value={form.name} maxLength={160} onChange={(e) => setForm({ ...form, name: e.target.value })} />}</Field>
        <Field label={t('loomc.external.pack')}>{(p) => (
          <Select {...p} value={form.sector_pack || enabled[0]?.id || ''} onChange={(e) => setForm({ ...form, sector_pack: e.target.value })}>
            {enabled.map((x: any) => <option key={x.id} value={x.id}>{x.label}</option>)}
          </Select>
        )}</Field>
        <Field label={t('loomc.mapping.timezone')}>{(p) => <Input {...p} dir="ltr" value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })} />}</Field>
        <Field label={t('loomc.mapping.currency')}>{(p) => <Input {...p} dir="ltr" maxLength={3} value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value.toUpperCase() })} />}</Field>
        <div className="md:col-span-2"><Button disabled={form.name.length < 2 || !enabled.length} onClick={create}>{t('loomc.external.create')}</Button></div>
      </div>
    </Card>
  );
}

function ExternalDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const { t, locale } = useI18n();
  const msg = useErrorMessage();
  const toast = useToast();
  const qc = useQueryClient();
  const base = `${BASE}/${id}`;
  const q = useApiQuery<any>(['platform', 'loom-external', id], base, { refetchInterval: 15000 });
  const o = useApiQuery<any[]>(['platform', 'loom-external', id, 'opps'], `${base}/opportunities`);
  if (q.isLoading) return <LoadingState rows={3} />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data;
  async function analyze() {
    try {
      await api(base, { method: 'POST', body: { action: 'analyze' } });
      toast({ tone: 'ok', text: t('loom.queued') });
      await qc.invalidateQueries({ queryKey: ['platform', 'loom-external', id] });
    } catch (e) { toast({ tone: 'danger', text: msg(e) }); }
  }
  const last = d.analyses[0];
  return (
    <div className="flex flex-col gap-4">
      <Card title={<span dir="auto">{d.business.name}</span>} actions={<div className="flex gap-2"><Button size="sm" onClick={analyze}>{t('loomc.external.analyze')}</Button><Button size="sm" variant="ghost" onClick={onBack}>{t('loomc.external.back')}</Button></div>}>
        <p className="text-sm text-ink-muted" dir="ltr">{d.business.sector_pack} · {d.business.timezone} · {d.business.currency}</p>
        {last ? <p className="text-sm">{last.status}{last.error_code ? ` · ${t(`errors.${last.error_code}`)}` : ''}</p> : null}
      </Card>
      <LoomConnectionsPanel base={base} tz={d.business.timezone} />
      <Card title={t('loomc.external.opportunities')}>
        {o.data?.length ? (
          <ul className="flex flex-col gap-1 text-sm">
            {o.data.map((x: any) => <li key={x.card.opportunity_id} className="flex flex-wrap gap-2"><Badge>{t(`loom.category.${x.card.category}`)}</Badge><span dir="auto">{x.card.title}</span><span className="text-ink-muted" dir="auto">{x.card.why_now}</span></li>)}
          </ul>
        ) : <EmptyState title={t('loom.empty')} />}
      </Card>
      <LoomWebhooksPanel base={base} tz={d.business.timezone} />
      <span className="sr-only">{locale}</span>
    </div>
  );
}

'use client';

import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useI18n } from '@/i18n/client';
import { api } from '../../api';
import { useApiQuery, useErrorMessage, useUnsavedChangesWarning } from '../../hooks';
import { Button } from '../../components/button';
import { Badge, EmptyState, ErrorState, LoadingState } from '../../components/feedback';
import { Checkbox, Field, FormErrorSummary, Input, Select } from '../../components/form';
import { Card, PageHeader } from '../../components/layout';
import { useToast } from '../../components/toast';
import { useStepUp } from '../stepup';
import { LoomKnowledgeList } from './LoomKnowledgeList';

const FACTORS = ['goal_fit', 'evidence', 'impact', 'feasibility', 'cost_effort', 'timing', 'risk'] as const;
const PACKS = ['beauty', 'retail', 'restaurant', 'professional_services'] as const;
const SOURCE_KINDS = ['official_calendar', 'school_calendar', 'religious_calendar', 'other'] as const;
type Source = { id: string; name: string; url: string; region: string; kind: string; license_note: string; enabled: boolean };
type Settings = {
  default_ranking_weights: Record<string, number>; cost_completeness_threshold: number;
  learned_model_thresholds: { min_days: number; min_completed_transactions: number }; event_sources: Source[]; enabled_sector_packs: string[];
};

/** /platform/loom — the platform defaults that replace Loom's open decisions (§21). */
export function LoomSettingsPage() {
  const { t } = useI18n();
  const msg = useErrorMessage();
  const toast = useToast();
  const qc = useQueryClient();
  const stepUp = useStepUp();
  const q = useApiQuery<{ settings: Settings; meta: Record<string, { version: number; is_default: boolean }> }>(['platform', 'loom'], '/api/v1/platform/loom/settings');
  const [f, setF] = useState<Settings | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  useUnsavedChangesWarning(dirty);
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { if (q.data && !f) setF(q.data.settings); }, [q.data, f]);
  if (q.isLoading || (!f && !q.error)) return <LoadingState rows={6} />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const s = f!;
  const meta = q.data!.meta;
  const set = (p: Partial<Settings>) => { setF({ ...s, ...p }); setDirty(true); };
  const total = Math.round(FACTORS.reduce((m, k) => m + (s.default_ranking_weights[k] ?? 0), 0) * 100);
  const tag = (k: keyof Settings) => <Badge tone={meta[k]?.is_default ? 'neutral' : 'info'}>{meta[k]?.is_default ? t('loom.admin.default') : t('loom.admin.version', { v: meta[k]?.version ?? 0 })}</Badge>;

  async function save() {
    setBusy(true); setErr(null);
    const original = q.data!.settings;
    const patch = Object.fromEntries(Object.entries(s).filter(([k, v]) => JSON.stringify(original[k as keyof Settings]) !== JSON.stringify(v)));
    try {
      if (Object.keys(patch).length) await stepUp(() => api('/api/v1/platform/loom/settings', { method: 'PUT', body: patch }));
      setDirty(false);
      toast({ tone: 'ok', text: t('states.saved') });
      await qc.invalidateQueries({ queryKey: ['platform', 'loom'] });
      setF(null);
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }

  const setSource = (i: number, p: Partial<Source>) => set({ event_sources: s.event_sources.map((x, j) => (j === i ? { ...x, ...p } : x)) });
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={t('loom.admin.title')} subtitle={t('loom.admin.subtitle')} actions={<Button loading={busy} disabled={!dirty || total !== 100} onClick={save}>{t('actions.save')}</Button>} />
      <FormErrorSummary message={err ? msg(err) : null} issues={(err as any)?.details?.issues} />
      <Card title={t('loom.admin.weights')} actions={tag('default_ranking_weights')}>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {FACTORS.map((k) => <Field key={k} label={t(`loom.factors.${k}`)}>{(p) => <Input {...p} type="number" dir="ltr" min={0} max={60} value={Math.round((s.default_ranking_weights[k] ?? 0) * 100)} onChange={(e) => set({ default_ranking_weights: { ...s.default_ranking_weights, [k]: Math.max(0, Math.min(60, Math.round(Number(e.target.value) || 0))) / 100 } })} />}</Field>)}
        </div>
        <p className={total === 100 ? 'mt-2 text-xs text-ink-muted' : 'mt-2 text-xs text-warn'}>{t('loom.setup.weights.sum', { sum: total })}</p>
      </Card>
      <div className="grid gap-4 md:grid-cols-2">
        <Card title={t('loom.admin.threshold')} actions={tag('cost_completeness_threshold')}>
          <Field label={t('loom.admin.threshold')}>{(p) => <Input {...p} type="number" dir="ltr" min={50} max={100} value={Math.round(s.cost_completeness_threshold * 100)} onChange={(e) => set({ cost_completeness_threshold: Math.max(50, Math.min(100, Math.round(Number(e.target.value) || 0))) / 100 })} />}</Field>
        </Card>
        <Card title={t('loom.admin.learned')} actions={tag('learned_model_thresholds')}>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('loom.admin.min_days')}>{(p) => <Input {...p} type="number" dir="ltr" min={30} max={1095} value={s.learned_model_thresholds.min_days} onChange={(e) => set({ learned_model_thresholds: { ...s.learned_model_thresholds, min_days: Math.round(Number(e.target.value) || 0) } })} />}</Field>
            <Field label={t('loom.admin.min_tx')}>{(p) => <Input {...p} type="number" dir="ltr" min={50} value={s.learned_model_thresholds.min_completed_transactions} onChange={(e) => set({ learned_model_thresholds: { ...s.learned_model_thresholds, min_completed_transactions: Math.round(Number(e.target.value) || 0) } })} />}</Field>
          </div>
        </Card>
      </div>
      <Card title={t('loom.admin.packs')} actions={tag('enabled_sector_packs')}>
        <div className="flex flex-wrap gap-4">
          {PACKS.map((k) => <Checkbox key={k} label={t(`loom.admin.pack.${k}`)} checked={s.enabled_sector_packs.includes(k)} onChange={(v) => set({ enabled_sector_packs: v ? [...s.enabled_sector_packs, k] : s.enabled_sector_packs.filter((x) => x !== k) })} />)}
        </div>
      </Card>
      <Card title={t('loom.admin.sources')} actions={<div className="flex items-center gap-2">{tag('event_sources')}<Button size="sm" variant="outline" disabled={s.event_sources.length >= 50} onClick={() => set({ event_sources: [...s.event_sources, { id: `src-${s.event_sources.length + 1}`, name: '', url: 'https://', region: 'SA', kind: 'official_calendar', license_note: '', enabled: false }] })}>{t('loom.admin.add_source')}</Button></div>}>
        {!s.event_sources.length ? <EmptyState title={t('loom.admin.sources_empty')} /> : (
          <ul className="flex flex-col gap-3">
            {s.event_sources.map((x, i) => (
              <li key={i} className="grid gap-2 rounded-xl border border-line p-3 sm:grid-cols-3">
                <Field label={t('loom.admin.source_id')}>{(p) => <Input {...p} dir="ltr" value={x.id} onChange={(e) => setSource(i, { id: e.target.value })} />}</Field>
                <Field label={t('loom.admin.source_name')}>{(p) => <Input {...p} value={x.name} onChange={(e) => setSource(i, { name: e.target.value })} />}</Field>
                <Field label={t('loom.admin.source_url')}>{(p) => <Input {...p} type="url" dir="ltr" value={x.url} onChange={(e) => setSource(i, { url: e.target.value })} />}</Field>
                <Field label={t('loom.admin.source_region')}>{(p) => <Input {...p} value={x.region} onChange={(e) => setSource(i, { region: e.target.value })} />}</Field>
                <Field label={t('loom.admin.source_kind')}>{(p) => <Select {...p} value={x.kind} onChange={(e) => setSource(i, { kind: e.target.value })}>{SOURCE_KINDS.map((k) => <option key={k} value={k}>{t(`loom.admin.source_kinds.${k}`)}</option>)}</Select>}</Field>
                <Field label={t('loom.admin.source_license')}>{(p) => <Input {...p} value={x.license_note} onChange={(e) => setSource(i, { license_note: e.target.value })} />}</Field>
                <div className="flex items-center justify-between sm:col-span-3">
                  <Checkbox label={t('loom.admin.enabled')} checked={x.enabled} onChange={(v) => setSource(i, { enabled: v })} />
                  <Button size="sm" variant="ghost" onClick={() => set({ event_sources: s.event_sources.filter((_, j) => j !== i) })}>{t('loom.admin.remove')}</Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <LoomKnowledgeList />
    </div>
  );
}

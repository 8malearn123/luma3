'use client';

import { useState, type ReactNode } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { useApiQuery } from '../hooks';
import { useAccess } from '../shell/access-context';
import { Button } from '../components/button';
import { Alert, Badge, ErrorState, LoadingState } from '../components/feedback';
import { Checkbox, Field, Input, MoneyInput, Select } from '../components/form';
import { Card } from '../components/layout';
import { loomKey, useAct } from './loom-shared';

const GOAL_KINDS = ['fill_quiet_times', 'reactivate_customers', 'grow_offerings', 'increase_margin', 'increase_conversion', 'grow_new_customers', 'sell_products', 'improve_reviews'] as const;
const FACTORS = ['goal_fit', 'evidence', 'impact', 'feasibility', 'cost_effort', 'timing', 'risk'] as const;
const TONES = ['formal', 'friendly', 'warm_luxury', 'playful'] as const;

/** The REQUIRED Loom setup checklist: each item shows «مطلوب» until the owner confirms it. */
export function LoomSetup() {
  const { t } = useI18n();
  const access = useAccess();
  const r = useApiQuery<any>(loomKey(access.slug, 'profile'), access.api('/loom/profile'));
  if (r.isLoading) return <LoadingState rows={5} />;
  if (r.error) return <ErrorState error={r.error} onRetry={() => r.refetch()} />;
  const p = r.data;
  const item = (id: string) => p.setup.items.find((i: any) => i.id === id);
  return (
    <div className="flex flex-col gap-4">
      <Alert tone={p.setup.complete ? 'ok' : 'info'} title={t('loom.setup.title')}>{p.setup.complete ? t('loom.setup.complete') : t('loom.setup.subtitle')}</Alert>
      <div className="grid gap-4 lg:grid-cols-2">
        <Goals p={p} confirmed={item('goals')?.confirmed} />
        <Budget p={p} confirmed={item('monthly_budget')?.confirmed} />
        <Discount p={p} confirmed={item('discount_policy')?.confirmed} />
        <Offerings p={p} confirmed={item('offerings_scope')?.confirmed} />
        <Tone p={p} confirmed={item('tone')?.confirmed} />
        <Weights p={p} confirmed={item('ranking_weights')?.confirmed} />
        <Consent p={p} confirmed={item('shared_training_consent')?.confirmed} />
      </div>
    </div>
  );
}

function Item({ title, confirmed, children }: { title: string; confirmed: boolean | undefined; children: ReactNode }) {
  const { t } = useI18n();
  return (
    <Card title={title} actions={confirmed ? <Badge tone="ok"><CheckCircle2 className="me-1 inline size-3.5" aria-hidden />{t('loom.setup.confirmed')}</Badge> : <Badge tone="warn">{t('loom.setup.required')}</Badge>}>
      {children}
    </Card>
  );
}

function useSave() {
  const { t } = useI18n();
  const { act, busy } = useAct();
  return { busy, save: (key: string, body: Record<string, unknown>) => act(key, '/loom/setup', { method: 'PUT', body, ok: t('loom.setup.saved') }) };
}

function Goals({ p, confirmed }: { p: any; confirmed?: boolean }) {
  const { t } = useI18n();
  const access = useAccess();
  const { save, busy } = useSave();
  const [goals, setGoals] = useState<Array<{ kind: string; priority: string }>>(p.goals.map((g: any) => ({ kind: g.kind, priority: g.priority })));
  const can = access.can('marketing.manage');
  return (
    <Item title={t('loom.setup.goals.title')} confirmed={confirmed}>
      <ul className="flex flex-col gap-2">
        {goals.map((g, i) => (
          <li key={i} className="flex flex-wrap items-end gap-2">
            <Field label={t('loom.setup.goals.title')} className="w-56">{(f) => <Select {...f} disabled={!can} value={g.kind} onChange={(e) => setGoals(goals.map((x, j) => (j === i ? { ...x, kind: e.target.value } : x)))}>{GOAL_KINDS.map((k) => <option key={k} value={k}>{t(`loom.setup.goal_kind.${k}`)}</option>)}</Select>}</Field>
            <Field label={t('loom.setup.goals.priority')} className="w-36">{(f) => <Select {...f} disabled={!can} value={g.priority} onChange={(e) => setGoals(goals.map((x, j) => (j === i ? { ...x, priority: e.target.value } : x)))}><option value="primary">{t('loom.setup.goals.primary')}</option><option value="secondary">{t('loom.setup.goals.secondary')}</option></Select>}</Field>
            {can ? <Button size="sm" variant="ghost" onClick={() => setGoals(goals.filter((_, j) => j !== i))}>{t('loom.setup.goals.remove')}</Button> : null}
          </li>
        ))}
        {!goals.length ? <li className="text-sm text-ink-muted">{t('loom.setup.goals.none')}</li> : null}
      </ul>
      {can ? (
        <div className="mt-3 flex gap-2">
          <Button size="sm" variant="outline" disabled={goals.length >= 8} onClick={() => setGoals([...goals, { kind: 'fill_quiet_times', priority: goals.length ? 'secondary' : 'primary' }])}>{t('loom.setup.goals.add')}</Button>
          <Button size="sm" loading={busy === 'goals'} onClick={() => save('goals', { goals: goals.map((g) => ({ ...g, offering_ids: [], note: null })) })}>{t('loom.setup.confirm')}</Button>
        </div>
      ) : null}
    </Item>
  );
}

function Budget({ p, confirmed }: { p: any; confirmed?: boolean }) {
  const { t } = useI18n();
  const access = useAccess();
  const { save, busy } = useSave();
  const [v, setV] = useState<number | null>(p.preferences.monthly_budget_minor);
  const can = access.can('marketing.manage');
  return (
    <Item title={t('loom.setup.budget.title')} confirmed={confirmed}>
      <div className="flex flex-col gap-2">
        <Checkbox disabled={!can} label={t('loom.setup.budget.none')} checked={v === null} onChange={(x) => setV(x ? null : 0)} />
        {v !== null ? <Field label={t('loom.setup.budget.title')} className="w-48">{(f) => <MoneyInput {...f} disabled={!can} value={v} onChange={(x) => setV(x ?? 0)} />}</Field> : null}
        {can ? <div><Button size="sm" loading={busy === 'budget'} onClick={() => save('budget', { monthly_budget_minor: v })}>{t('loom.setup.confirm')}</Button></div> : null}
      </div>
    </Item>
  );
}

function Discount({ p, confirmed }: { p: any; confirmed?: boolean }) {
  const { t } = useI18n();
  const access = useAccess();
  const { save, busy } = useSave();
  const [no, setNo] = useState<boolean>(p.preferences.no_discounts);
  const [max, setMax] = useState<number>(p.preferences.max_discount_bp);
  const can = access.can('marketing.manage');
  return (
    <Item title={t('loom.setup.discount.title')} confirmed={confirmed}>
      <div className="flex flex-col gap-2">
        <Checkbox disabled={!can} label={t('loom.setup.discount.no_discounts')} checked={no} onChange={setNo} />
        {!no ? <Field label={t('loom.setup.discount.max')} className="w-40">{(f) => <Input {...f} type="number" dir="ltr" min={0} max={90} disabled={!can} value={max / 100} onChange={(e) => setMax(Math.round(Math.min(90, Math.max(0, Number(e.target.value) || 0)) * 100))} />}</Field> : null}
        {can ? <div><Button size="sm" loading={busy === 'discount'} onClick={() => save('discount', { discount_policy: { no_discounts: no, max_discount_bp: no ? 0 : max } })}>{t('loom.setup.confirm')}</Button></div> : null}
      </div>
    </Item>
  );
}

function Offerings({ p, confirmed }: { p: any; confirmed?: boolean }) {
  const { t } = useI18n();
  const access = useAccess();
  const { save, busy } = useSave();
  const [ex, setEx] = useState<string[]>(p.preferences.excluded_offerings);
  const [gr, setGr] = useState<string[]>(p.preferences.growth_offerings);
  const can = access.can('marketing.manage');
  const toggle = (list: string[], set: (v: string[]) => void, id: string, on: boolean) => set(on ? [...list, id] : list.filter((x) => x !== id));
  return (
    <Item title={t('loom.setup.offerings.title')} confirmed={confirmed}>
      <p className="mb-2 text-xs text-ink-muted">{t('loom.setup.offerings.hint')}</p>
      <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto text-sm">
        {p.offerings.map((o: any) => (
          <li key={o.id} className="flex flex-wrap items-center justify-between gap-2">
            <span dir="auto">{o.name}</span>
            <span className="flex gap-3">
              <Checkbox disabled={!can} label={t('loom.setup.offerings.excluded')} checked={ex.includes(o.id)} onChange={(v) => toggle(ex, setEx, o.id, v)} />
              <Checkbox disabled={!can} label={t('loom.setup.offerings.growth')} checked={gr.includes(o.id)} onChange={(v) => toggle(gr, setGr, o.id, v)} />
            </span>
          </li>
        ))}
      </ul>
      {can ? <div className="mt-2"><Button size="sm" loading={busy === 'offerings'} onClick={() => save('offerings', { offerings_scope: { excluded: ex, growth: gr } })}>{t('loom.setup.confirm')}</Button></div> : null}
    </Item>
  );
}

function Tone({ p, confirmed }: { p: any; confirmed?: boolean }) {
  const { t } = useI18n();
  const access = useAccess();
  const { save, busy } = useSave();
  const [style, setStyle] = useState<string>(p.preferences.tone?.style ?? 'friendly');
  const [banned, setBanned] = useState<string>((p.preferences.tone?.banned_words ?? []).join(', '));
  const can = access.can('marketing.manage');
  return (
    <Item title={t('loom.setup.tone.title')} confirmed={confirmed}>
      <div className="flex flex-col gap-2">
        <Field label={t('loom.setup.tone.style')} className="w-56">{(f) => <Select {...f} disabled={!can} value={style} onChange={(e) => setStyle(e.target.value)}>{TONES.map((x) => <option key={x} value={x}>{t(`loom.setup.tone.styles.${x}`)}</option>)}</Select>}</Field>
        <Field label={t('loom.setup.tone.banned')}>{(f) => <Input {...f} disabled={!can} maxLength={600} value={banned} onChange={(e) => setBanned(e.target.value)} />}</Field>
        {can ? <div><Button size="sm" loading={busy === 'tone'} onClick={() => save('tone', { tone: { style, banned_words: banned.split(/[,،]/).map((w) => w.trim()).filter(Boolean).slice(0, 30) } })}>{t('loom.setup.confirm')}</Button></div> : null}
      </div>
    </Item>
  );
}

function Weights({ p, confirmed }: { p: any; confirmed?: boolean }) {
  const { t } = useI18n();
  const access = useAccess();
  const { save, busy } = useSave();
  const [w, setW] = useState<Record<string, number>>(Object.fromEntries(FACTORS.map((f) => [f, Math.round((p.preferences.ranking_weights[f] ?? 0) * 100)])));
  const total = FACTORS.reduce((m, f) => m + (w[f] ?? 0), 0);
  const can = access.can('marketing.manage');
  return (
    <Item title={t('loom.setup.weights.title')} confirmed={confirmed}>
      <p className="mb-2 text-xs text-ink-muted">{t('loom.setup.weights.current', { source: t(`loom.setup.weights.${p.preferences.weights_source}`) })}</p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {FACTORS.map((f) => <Field key={f} label={t(`loom.factors.${f}`)}>{(x) => <Input {...x} type="number" dir="ltr" min={0} max={50} disabled={!can} value={w[f]} onChange={(e) => setW({ ...w, [f]: Math.max(0, Math.min(50, Math.round(Number(e.target.value) || 0))) })} />}</Field>)}
      </div>
      <p className={total === 100 ? 'mt-1 text-xs text-ink-muted' : 'mt-1 text-xs text-warn'}>{t('loom.setup.weights.sum', { sum: total })}</p>
      {can ? (
        <div className="mt-2 flex flex-wrap gap-2">
          <Button size="sm" variant="outline" loading={busy === 'wdef'} onClick={() => save('wdef', { ranking_weights: { mode: 'default' } })}>{t('loom.setup.weights.use_default')}</Button>
          <Button size="sm" disabled={total !== 100} loading={busy === 'wcus'} onClick={() => save('wcus', { ranking_weights: { mode: 'custom', weights: Object.fromEntries(FACTORS.map((f) => [f, (w[f] ?? 0) / 100])) } })}>{t('loom.setup.weights.custom')}</Button>
        </div>
      ) : null}
    </Item>
  );
}

function Consent({ p, confirmed }: { p: any; confirmed?: boolean }) {
  const { t } = useI18n();
  const access = useAccess();
  const { save, busy } = useSave();
  const owner = access.can('business.manage');
  return (
    <Item title={t('loom.setup.consent.title')} confirmed={confirmed}>
      <p className="text-sm">{t('loom.setup.consent.hint')}</p>
      {confirmed ? <p className="mt-1 text-sm font-medium">{p.preferences.shared_training_consent ? t('loom.setup.consent.allow') : t('loom.setup.consent.deny')}</p> : null}
      {owner ? (
        <div className="mt-2 flex gap-2">
          <Button size="sm" variant="outline" loading={busy === 'cno'} onClick={() => save('cno', { shared_training_consent: false })}>{t('loom.setup.consent.deny')}</Button>
          <Button size="sm" variant="ghost" loading={busy === 'cyes'} onClick={() => save('cyes', { shared_training_consent: true })}>{t('loom.setup.consent.allow')}</Button>
        </div>
      ) : <p className="mt-2 text-xs text-ink-muted">{t('loom.setup.consent.owner_only')}</p>}
    </Item>
  );
}

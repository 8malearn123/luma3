'use client';

import { useI18n } from '@/i18n/client';
import { formatMoney } from '@/shared/format';
import { useApiQuery } from '../hooks';
import { useAccess } from '../shell/access-context';
import { Badge, ErrorState, LoadingState } from '../components/feedback';
import { Card } from '../components/layout';
import { loomKey } from './loom-shared';

type Tone = 'neutral' | 'ok' | 'warn' | 'danger' | 'info' | 'brand';
const TONE: Record<string, Tone> = { ok: 'ok', constrained: 'warn', blocked: 'danger', unknown: 'neutral', reorder_needed: 'danger', no_recipe: 'warn', not_applicable: 'neutral' };

/** Structured Loom actions of a plan version (loom.plan_actions): capacity / material notes, real slots, owners, knowledge. */
export function LoomPlanActions({ planId, versionId }: { planId: string; versionId: string }) {
  const { t } = useI18n();
  const access = useAccess();
  const r = useApiQuery<any>(loomKey(access.slug, 'plan-actions', planId, versionId), access.api(`/loom/plans/${planId}/actions?version_id=${versionId}`));
  if (r.isLoading) return <LoadingState rows={2} />;
  if (r.error) return <ErrorState error={r.error} onRetry={() => r.refetch()} />;
  if (!r.data.actions.length) return null;
  return (
    <Card title={t('loomp.plan.actions_title')}>
      {r.data.run?.notes?.length ? <ul className="mb-3 list-disc ps-5 text-xs text-warn">{r.data.run.notes.map((n: string) => <li key={n} dir="auto">{n}</li>)}</ul> : null}
      <LoomPlanActionList actions={r.data.actions} />
    </Card>
  );
}

export function LoomPlanActionList({ actions, compact }: { actions: any[]; compact?: boolean }) {
  const { t, locale } = useI18n();
  const access = useAccess();
  return (
    <ul className="flex flex-col gap-3">
      {actions.map((a) => (
        <li key={a.id} className="rounded-xl border border-line p-3 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium" dir="auto">{a.title}</span>
            <div className="flex flex-wrap gap-1.5">
              <Badge tone={a.role === 'prerequisite' ? 'warn' : 'brand'}>{t(`loomp.plan.role.${a.role}`)}</Badge>
              <Badge>{t(`loom.action_kind.${a.action_kind}`)}</Badge>
              {a.revision_note ? <Badge tone="info">{t('loomp.plan.revised')}</Badge> : null}
            </div>
          </div>
          <p className="mt-1 text-xs text-ink-muted" dir="ltr">{a.schedule.from} → {a.schedule.to}</p>
          {!compact ? <p className="mt-1" dir="auto">{a.description}</p> : null}
          {a.content_idea && !compact ? <p className="mt-1 text-xs text-ink-muted" dir="auto">{t('loomp.plan.content_idea')}: {a.content_idea}</p> : null}
          <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
            <Badge tone={TONE[a.operational.capacity.status]}>{t('loom.card.capacity')}: {t(`loom.capacity.${a.operational.capacity.status}`)}</Badge>
            <Badge tone={TONE[a.operational.inventory.status]}>{t('loom.card.inventory')}: {t(`loom.inventory.${a.operational.inventory.status}`)}</Badge>
            <Badge>{t('loomp.plan.owner')}: {a.owner}</Badge>
            {!compact ? <Badge>{t('loomp.plan.budget')}: {a.budget.amount_minor == null ? '—' : formatMoney(a.budget.amount_minor, access.currency, locale)} ({t(`loom.cost_basis.${a.budget.basis}`)})</Badge> : null}
          </div>
          <p className="mt-1 text-xs text-ink-muted" dir="auto">{a.operational.capacity.note}{a.operational.inventory.note ? ` · ${a.operational.inventory.note}` : ''}</p>
          {a.operational.requirements.length ? <ul className="mt-1 list-disc ps-5 text-xs" dir="auto">{a.operational.requirements.map((x: string, i: number) => <li key={i}>{x}</li>)}</ul> : null}
          {a.highlighted.map((h: any) => (
            <div key={h.offering_id} className="mt-2 rounded-lg bg-luma-50 p-2 text-xs">
              <p><span className="font-medium" dir="auto">{h.name}</span> · {h.free_slots == null ? t('loomp.plan.no_schedule') : t('loomp.plan.free_slots', { n: h.free_slots })}</p>
              {h.sample_slots.length ? <p className="text-ink-muted" dir="ltr">{h.sample_slots.join(' · ')}</p> : null}
              {h.materials.length ? <p className="text-ink-muted" dir="auto">{t('loomp.plan.materials')}: {h.materials.map((m: any) => `${m.name} ${m.per_service} ${m.unit} (${t('loomp.plan.available', { n: m.available })})`).join('، ')}</p>
                : <p className="text-ink-muted">{t(`loom.inventory.${h.materials_status}`)}</p>}
            </div>
          ))}
          {a.revision_note ? <p className="mt-1 text-xs text-warn" dir="auto">{a.revision_note}</p> : null}
          {a.knowledge?.length && !compact ? <p className="mt-1 text-xs text-ink-muted">{t('loomp.card.methodology')}: {a.knowledge.map((k: any) => k.title).join(' · ')}</p> : null}
        </li>
      ))}
    </ul>
  );
}

'use client';

import { useI18n } from '@/i18n/client';
import { Badge } from '../components/feedback';

const INCIDENT_TONE: Record<string, 'neutral' | 'ok' | 'warn' | 'danger' | 'info'> = {
  submitted: 'info', under_review: 'warn', confirmed: 'danger', rejected: 'neutral', corrected: 'ok',
};
const DECISION_TONE: Record<string, 'neutral' | 'ok' | 'warn' | 'danger' | 'info'> = {
  active: 'warn', superseded: 'neutral', revoked: 'neutral', expired: 'neutral',
};
const APPEAL_TONE: Record<string, 'neutral' | 'ok' | 'warn' | 'danger' | 'info'> = {
  submitted: 'info', under_review: 'warn', accepted: 'ok', rejected: 'neutral', withdrawn: 'neutral',
};

export function IncidentStatus({ status }: { status: string }) {
  const { t } = useI18n();
  return <Badge tone={INCIDENT_TONE[status] ?? 'neutral'}>{t(`policy.statuses.${status}`)}</Badge>;
}

export function DecisionStatus({ status }: { status: string }) {
  const { t } = useI18n();
  return <Badge tone={DECISION_TONE[status] ?? 'neutral'}>{t(`policy.decisions.status.${status}`)}</Badge>;
}

export function AppealStatus({ status }: { status: string }) {
  const { t } = useI18n();
  const key = status === 'accepted' ? 'policy.appeals.accepted' : status === 'rejected' ? 'policy.appeals.rejected' : `policy.appeals.${status}`;
  return <Badge tone={APPEAL_TONE[status] ?? 'neutral'}>{t(key)}</Badge>;
}

export function ActionBadge({ action }: { action: string }) {
  const { t } = useI18n();
  return <Badge tone={action === 'default' ? 'neutral' : action === 'suspend_account' ? 'danger' : 'brand'}>{t(`policy.actions_labels.${action}`)}</Badge>;
}

/** datetime-local value ↔ ISO instant (browser local time, shown with the timezone note). */
export function toLocalInput(d: Date | string | null | undefined) {
  if (!d) return '';
  const x = new Date(d);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}T${pad(x.getHours())}:${pad(x.getMinutes())}`;
}
export function fromLocalInput(v: string): string | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

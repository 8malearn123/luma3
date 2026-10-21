'use client';

import { useState } from 'react';
import { LifeBuoy } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { useApiQuery, useDebounced } from '../hooks';
import { Badge, EmptyState, ErrorState, LoadingState } from '../components/feedback';
import { Checkbox, Field, Input, Select } from '../components/form';
import { DataTable, PageHeader, Pager } from '../components/layout';
import { cx } from '../components/cx';
import { useAccess } from '../shell/access-context';
import { AuditDetail, useCursorPages, type AuditRow } from '../platform/Audit';
import { Toolbar, When, qs } from '../platform/common';

/** The business's own audit log; LUMA support and platform actions are highlighted. */
export function TenantAuditPage({ initialSupportOnly }: { initialSupportOnly?: boolean }) {
  const { t } = useI18n();
  const access = useAccess();
  const [action, setAction] = useState('');
  const [actor, setActor] = useState('');
  const [kind, setKind] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [supportOnly, setSupportOnly] = useState(!!initialSupportOnly);
  const [open, setOpen] = useState<AuditRow | null>(null);
  const pages = useCursorPages();
  const dAction = useDebounced(action.toLowerCase().replace(/[^a-z0-9_.]/g, ''));
  const path = access.api(`/audit${qs({ action: dAction, actor_user_id: actor, actor_kind: kind, from, to, support_only: supportOnly ? '1' : undefined, limit: 25, cursor: pages.cursor })}`);
  const q = useApiQuery<{ items: AuditRow[]; next_cursor: string | null; actors: Array<{ id: string; name: string }> }>(['tenant-audit', path], path);
  const [actors, setActors] = useState<Array<{ id: string; name: string }>>([]);
  // The actor list comes with the first page only; keep it while paging (state adjusted during render).
  if (q.data?.actors?.length && !actors.length) setActors(q.data.actors);
  const change = <T,>(setter: (v: T) => void) => (v: T) => { setter(v); pages.reset(); };
  return (
    <div>
      <PageHeader title={t('biz_audit.title')} subtitle={t('biz_audit.subtitle')} />
      <Toolbar>
        <Field label={t('platform.audit.action')} className="w-44">{(p) => <Input {...p} dir="ltr" placeholder="service." value={action} onChange={(e) => change(setAction)(e.target.value)} />}</Field>
        <Field label={t('platform.audit.actor')} className="w-48">{(p) => <Select {...p} value={actor} onChange={(e) => change(setActor)(e.target.value)}><option value="">{t('platform.all')}</option>{actors.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select>}</Field>
        <Field label={t('platform.audit.actor_kind')} className="w-36">{(p) => <Select {...p} value={kind} onChange={(e) => change(setKind)(e.target.value)}><option value="">{t('platform.all')}</option>{['user', 'support', 'platform', 'system', 'customer'].map((k) => <option key={k} value={k}>{t(`platform.actor_kind.${k}`)}</option>)}</Select>}</Field>
        <Field label={t('fields.from')} className="w-40">{(p) => <Input {...p} type="date" value={from} onChange={(e) => change(setFrom)(e.target.value)} />}</Field>
        <Field label={t('fields.to')} className="w-40">{(p) => <Input {...p} type="date" value={to} onChange={(e) => change(setTo)(e.target.value)} />}</Field>
        <div className="pb-2"><Checkbox label={t('biz_audit.support_only')} checked={supportOnly} onChange={change(setSupportOnly)} /></div>
      </Toolbar>
      {q.isLoading ? <LoadingState /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !q.data!.items.length ? <EmptyState /> : (
        <>
          <DataTable rows={q.data!.items} rowKey={(r) => r.id} onRowClick={setOpen} caption={t('biz_audit.title')} columns={[
            { key: 'when', header: t('platform.audit.when'), cell: (r) => <When v={r.created_at} /> },
            { key: 'action', header: t('platform.audit.action'), cell: (r) => (
              <span className={cx('inline-flex items-center gap-1 font-mono text-xs', r.is_support && 'font-semibold text-warn')} dir="ltr">
                {r.is_support ? <LifeBuoy className="size-3.5" aria-label={t('platform.audit.support_action')} /> : null}{r.action}
              </span>
            ) },
            { key: 'actor', header: t('platform.audit.actor'), cell: (r) => <div className="text-xs"><p>{r.actor_name ?? '—'}</p><p className="flex gap-1">{r.is_support ? <Badge tone="warn">{t('biz_audit.luma_support')}</Badge> : <span className="text-ink-muted">{t(`platform.actor_kind.${r.actor_kind}`)}</span>}</p></div> },
            { key: 'target', header: t('platform.audit.target'), className: 'hidden md:table-cell', cell: (r) => <span className="font-mono text-xs" dir="ltr">{r.target_type ?? ''}</span> },
          ]} />
          <Pager hasPrev={pages.hasPrev} hasNext={!!q.data!.next_cursor} onPrev={pages.prev} onNext={() => q.data!.next_cursor && pages.next(q.data!.next_cursor)} />
        </>
      )}
      {open ? <AuditDetail row={open} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}

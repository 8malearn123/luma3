'use client';

import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { useApiQuery, useDebounced } from '../hooks';
import { Badge, EmptyState, ErrorState, LoadingState } from '../components/feedback';
import { Checkbox, Field, Input, Select } from '../components/form';
import { DataTable, PageHeader, Pager } from '../components/layout';
import { Drawer } from '../components/overlay';
import { KV, Toolbar, When, qs } from './common';

export type AuditRow = {
  id: string; action: string; actor_kind: string; actor_user_id: string | null; support_grant_id: string | null; target_type: string | null; target_id: string | null;
  data: Record<string, unknown>; created_at: string; actor_name: string | null; actor_email?: string | null; tenant_slug?: string | null; tenant_name?: string | null;
  request_id?: string | null; ip?: string | null; is_support?: boolean;
};

const KINDS = ['user', 'platform', 'support', 'system', 'customer', 'anonymous'];

/** Keyset pagination with a stack of previous cursors. */
export function useCursorPages() {
  const [stack, setStack] = useState<string[]>([]);
  return {
    cursor: stack[stack.length - 1],
    reset: () => setStack([]),
    next: (c: string) => setStack((s) => [...s, c]),
    prev: () => setStack((s) => s.slice(0, -1)),
    hasPrev: stack.length > 0,
  };
}

export function AuditDetail({ row, onClose }: { row: AuditRow; onClose: () => void }) {
  const { t } = useI18n();
  return (
    <Drawer open onClose={onClose} title={<span className="font-mono text-base" dir="ltr">{row.action}</span>}>
      <dl>
        <KV label={t('platform.audit.when')}><When v={row.created_at} /></KV>
        <KV label={t('platform.audit.actor')}>{row.actor_name ?? '—'} <span className="block text-xs text-ink-muted">{t(`platform.actor_kind.${row.actor_kind}`)}</span></KV>
        {row.tenant_slug ? <KV label={t('platform.business')}>{row.tenant_name} <span className="text-xs" dir="ltr">/{row.tenant_slug}</span></KV> : null}
        {row.target_type ? <KV label={t('platform.audit.target')}><span className="font-mono text-xs" dir="ltr">{row.target_type}:{row.target_id}</span></KV> : null}
        {row.support_grant_id ? <KV label={t('platform.audit.support_action')}><Badge tone="warn">{row.support_grant_id.slice(0, 8)}</Badge></KV> : null}
        {row.request_id ? <KV label={t('platform.audit.request')}><span className="font-mono text-xs" dir="ltr">{row.request_id}</span></KV> : null}
      </dl>
      <h3 className="mt-4 text-sm font-semibold">{t('platform.audit.data')}</h3>
      <p className="text-xs text-ink-muted">{t('platform.audit.redacted')}</p>
      <pre dir="ltr" className="mt-2 max-h-96 overflow-auto rounded-lg bg-luma-50 p-3 text-xs">{JSON.stringify(row.data, null, 2)}</pre>
    </Drawer>
  );
}

export function PlatformAuditPage({ initial }: { initial: { sensitive_only?: string; tenant?: string } }) {
  const { t } = useI18n();
  const [tenant, setTenant] = useState(initial.tenant ?? '');
  const [actor, setActor] = useState('');
  const [action, setAction] = useState('');
  const [kind, setKind] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [sensitive, setSensitive] = useState(initial.sensitive_only === '1');
  const [open, setOpen] = useState<AuditRow | null>(null);
  const pages = useCursorPages();
  const fJson = useDebounced(JSON.stringify({ tenant, actor, action: action.toLowerCase().replace(/[^a-z0-9_.]/g, ''), kind, from, to, sensitive }));
  const f = JSON.parse(fJson) as { tenant: string; actor: string; action: string; kind: string; from: string; to: string; sensitive: boolean };
  const path = `/api/v1/platform/audit${qs({ tenant: f.tenant, actor: f.actor, action: f.action, actor_kind: f.kind, from: f.from, to: f.to, sensitive_only: f.sensitive ? '1' : undefined, limit: 25, cursor: pages.cursor })}`;
  const q = useApiQuery<{ items: AuditRow[]; next_cursor: string | null }>(['platform', 'audit', path], path);
  const change = <T,>(setter: (v: T) => void) => (v: T) => { setter(v); pages.reset(); };
  return (
    <div>
      <PageHeader title={t('platform.audit.title')} subtitle={t('platform.audit.subtitle')} />
      <Toolbar>
        <Field label={t('platform.business')} className="w-40">{(p) => <Input {...p} dir="ltr" placeholder="slug" value={tenant} onChange={(e) => change(setTenant)(e.target.value)} />}</Field>
        <Field label={t('platform.audit.actor')} className="w-48">{(p) => <Input {...p} dir="ltr" placeholder={t('platform.audit.actor_hint')} value={actor} onChange={(e) => change(setActor)(e.target.value)} />}</Field>
        <Field label={t('platform.audit.action')} className="w-44">{(p) => <Input {...p} dir="ltr" placeholder="platform." value={action} onChange={(e) => change(setAction)(e.target.value)} />}</Field>
        <Field label={t('platform.audit.actor_kind')} className="w-36">{(p) => <Select {...p} value={kind} onChange={(e) => change(setKind)(e.target.value)}><option value="">{t('platform.all')}</option>{KINDS.map((k) => <option key={k} value={k}>{t(`platform.actor_kind.${k}`)}</option>)}</Select>}</Field>
        <Field label={t('fields.from')} className="w-40">{(p) => <Input {...p} type="date" value={from} onChange={(e) => change(setFrom)(e.target.value)} />}</Field>
        <Field label={t('fields.to')} className="w-40">{(p) => <Input {...p} type="date" value={to} onChange={(e) => change(setTo)(e.target.value)} />}</Field>
        <div className="pb-2"><Checkbox label={t('platform.audit.sensitive_only')} checked={sensitive} onChange={change(setSensitive)} /></div>
      </Toolbar>
      {q.isLoading ? <LoadingState /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !q.data!.items.length ? <EmptyState /> : (
        <>
          <DataTable rows={q.data!.items} rowKey={(r) => r.id} onRowClick={setOpen} caption={t('platform.audit.title')} columns={[
            { key: 'when', header: t('platform.audit.when'), cell: (r) => <When v={r.created_at} /> },
            { key: 'action', header: t('platform.audit.action'), cell: (r) => <span className="inline-flex items-center gap-1 font-mono text-xs" dir="ltr">{r.support_grant_id ? <AlertTriangle className="size-3.5 text-warn" aria-label={t('platform.audit.support_action')} /> : null}{r.action}</span> },
            { key: 'actor', header: t('platform.audit.actor'), cell: (r) => <div className="text-xs"><p>{r.actor_name ?? '—'}</p><p className="text-ink-muted">{t(`platform.actor_kind.${r.actor_kind}`)}</p></div> },
            { key: 'tenant', header: t('platform.business'), className: 'hidden md:table-cell', cell: (r) => r.tenant_slug ? <span dir="ltr" className="text-xs">/{r.tenant_slug}</span> : <span className="text-xs text-ink-muted">{t('platform.audit.platform_level')}</span> },
            { key: 'target', header: t('platform.audit.target'), className: 'hidden lg:table-cell', cell: (r) => <span className="font-mono text-xs" dir="ltr">{r.target_type ?? ''}</span> },
          ]} />
          <Pager hasPrev={pages.hasPrev} hasNext={!!q.data!.next_cursor} onPrev={pages.prev} onNext={() => q.data!.next_cursor && pages.next(q.data!.next_cursor)} />
        </>
      )}
      {open ? <AuditDetail row={open} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}

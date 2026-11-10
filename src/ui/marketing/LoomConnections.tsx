'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useI18n } from '@/i18n/client';
import { formatDateTime } from '@/shared/format';
import { api } from '../api';
import { useApiQuery, useErrorMessage } from '../hooks';
import { useAccess } from '../shell/access-context';
import { Button } from '../components/button';
import { Alert, Badge, EmptyState, ErrorState, LoadingState } from '../components/feedback';
import { Checkbox, Field, Input, Select, Textarea } from '../components/form';
import { Card } from '../components/layout';
import { useToast } from '../components/toast';

/**
 * Loom connections (phase 7): lifecycle, mapping step, CSV uploads, first-
 * snapshot review gate, suspected duplicates and outgoing webhooks. The
 * panel is host-neutral: `base` is the API prefix of one business (a LUMA
 * tenant's /api/v1/t/{slug}/loom or an external business under
 * /api/v1/platform/loom/businesses/{id}).
 */
const ENTITIES = ['offerings', 'offering_requirements', 'inventory_items', 'resources', 'capacity_windows', 'transactions', 'transaction_lines', 'cost_facts', 'demand_signals', 'reviews', 'customers'] as const;
const EVENTS = ['plan.ready', 'opportunity.created', 'plan.revision_proposed', 'outcome.measured'] as const;
const REVIEW_TONE: Record<string, 'neutral' | 'ok' | 'warn' | 'danger' | 'info'> = { not_required: 'neutral', pending_mapping: 'warn', pending_review: 'info', approved: 'ok', rejected: 'danger' };

function useCall(keys: unknown[][]) {
  const qc = useQueryClient();
  const toast = useToast();
  const msg = useErrorMessage();
  const [busy, setBusy] = useState<string | null>(null);
  const call = async <T = any>(key: string, path: string, method: string, body?: unknown, ok?: string): Promise<T | null> => {
    setBusy(key);
    try {
      const r = await api<T>(path, { method, body: body ?? {} });
      for (const k of keys) await qc.invalidateQueries({ queryKey: k });
      if (ok) toast({ tone: 'ok', text: ok });
      return r;
    } catch (e) { toast({ tone: 'danger', text: msg(e) }); return null; } finally { setBusy(null); }
  };
  return { call, busy };
}

const parseJson = (s: string): unknown => { try { return s.trim() ? JSON.parse(s) : {}; } catch { return undefined; } };

/** Tenant tab «الربط والبيانات»: sector pack, connections, webhooks. */
export function LoomConnections() {
  const access = useAccess();
  if (!access.can('business.manage')) return <SectorVocabulary base={access.api('/loom')} readOnly />;
  return (
    <div className="flex flex-col gap-4">
      <SectorVocabulary base={access.api('/loom')} />
      <LoomConnectionsPanel base={access.api('/loom')} tz={access.timezone} />
      <LoomWebhooksPanel base={access.api('/loom')} tz={access.timezone} />
    </div>
  );
}

function SectorVocabulary({ base, readOnly }: { base: string; readOnly?: boolean }) {
  const { t } = useI18n();
  const r = useApiQuery<any>(['loom-sector', base], `${base}/sector-pack`);
  const { call, busy } = useCall([['loom-sector', base]]);
  if (r.isLoading) return <LoadingState rows={1} />;
  if (r.error) return <ErrorState error={r.error} onRetry={() => r.refetch()} />;
  const d = r.data;
  const cur = d.packs.find((p: any) => p.id === d.current);
  return (
    <Card title={t('loomc.sector.title')}>
      <p className="text-sm">{t('loomc.sector.current', { name: cur?.label ?? d.current })}</p>
      <p className="text-sm text-ink-muted">{t('loomc.vocabulary', { offering: d.vocabulary.offering ?? '—', resource: d.vocabulary.resource ?? '—', customer: d.vocabulary.customer ?? '—' })}</p>
      {readOnly ? null : (
        <div className="mt-2 flex flex-wrap gap-2">
          {d.packs.map((p: any) => (
            <Button key={p.id} size="sm" variant={p.id === d.current ? 'primary' : 'ghost'} disabled={!p.enabled || p.id === d.current || busy !== null}
              title={p.enabled ? undefined : t('loomc.sector.disabled')} onClick={() => call('pack', `${base}/sector-pack`, 'PUT', { sector_pack: p.id }, t('states.saved'))}>{p.label}</Button>
          ))}
        </div>
      )}
    </Card>
  );
}

export function LoomConnectionsPanel({ base, tz = 'Asia/Riyadh' }: { base: string; tz?: string }) {
  const { t, locale } = useI18n();
  const list = useApiQuery<any[]>(['loom-connections', base], `${base}/connections`);
  const [open, setOpen] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const { call, busy } = useCall([['loom-connections', base]]);
  const [form, setForm] = useState({ kind: 'csv_import', name: '', base_url: 'https://', paths: '{\n  "offerings": "/products",\n  "transactions": "/orders",\n  "transaction_lines": "/order-lines"\n}', auth: 'bearer', secret: '' });
  if (list.isLoading) return <LoadingState rows={3} />;
  if (list.error) return <ErrorState error={list.error} onRetry={() => list.refetch()} />;
  async function create() {
    const paths = parseJson(form.paths);
    const body = form.kind === 'rest'
      ? { kind: 'rest', name: form.name, config: { base_url: form.base_url, paths, auth: { type: form.auth } }, ...(form.secret ? { secret: form.secret } : {}) }
      : { kind: 'csv_import', name: form.name };
    const r = await call<any>('create', `${base}/connections`, 'POST', body, t('states.saved'));
    if (r) { setCreated(r.ingest_secret); setForm({ ...form, name: '', secret: '' }); setOpen(r.connection.id); }
  }
  return (
    <Card title={t('loomc.title')}>
      <p className="mb-3 text-sm text-ink-muted">{t('loomc.subtitle')}</p>
      {created ? <Alert tone="warn" title={t('loomc.create.ingest_secret')}><code dir="ltr" className="break-all">{created}</code></Alert> : null}
      {list.data!.length ? (
        <ul className="flex flex-col gap-2">
          {list.data!.map((c) => (
            <li key={c.id} className="rounded border border-line p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <strong dir="auto">{c.name}</strong>
                  <Badge>{t(`loomc.kind.${c.kind}`)}</Badge>
                  <Badge tone={c.status === 'error' ? 'danger' : c.status === 'paused' ? 'warn' : 'ok'}>{t(`loomc.status.${c.status}`)}</Badge>
                  <Badge tone={REVIEW_TONE[c.review_status] ?? 'neutral'}>{t(`loomc.review.${c.review_status}`)}</Badge>
                  {c.primary_source ? <Badge tone="brand">{t('loomc.review.primary')}</Badge> : null}
                </div>
                {c.staged ? <Button size="sm" variant="ghost" onClick={() => setOpen(open === c.id ? null : c.id)}>{open === c.id ? t('loomc.actions.close') : t('loomc.actions.open')}</Button> : null}
              </div>
              <p className="mt-1 text-xs text-ink-muted">
                {t('loomc.list.last_sync')}: {c.last_sync_at ? formatDateTime(c.last_sync_at, { locale, tz }) : t('loomc.list.never')}
                {' · '}{t('loomc.list.records')}: {Object.entries(c.record_counts ?? {}).map(([k, v]: [string, any]) => `${k} ${v.live}`).join(', ') || '—'}
                {c.health?.status ? ` · ${t('loomc.list.health')}: ${c.health.status}${c.health.detail ? ` (${c.health.detail})` : ''}` : ''}
              </p>
              {c.last_error ? <p className="text-xs text-danger" dir="ltr">{t('loomc.list.last_error')}: {c.last_error}</p> : null}
              {open === c.id ? <ConnectionDetail base={base} id={c.id} /> : null}
            </li>
          ))}
        </ul>
      ) : <EmptyState title={t('loomc.list.empty')} />}
      <div className="mt-4 grid gap-3 border-t border-line pt-3 md:grid-cols-2">
        <h3 className="md:col-span-2 font-semibold">{t('loomc.create.title')}</h3>
        <Field label={t('loomc.create.name')} required>{(p) => <Input {...p} value={form.name} maxLength={120} onChange={(e) => setForm({ ...form, name: e.target.value })} />}</Field>
        <Field label={t('loomc.create.kind')}>{(p) => (
          <Select {...p} value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
            <option value="csv_import">{t('loomc.kind.csv_import')}</option><option value="rest">{t('loomc.kind.rest')}</option>
          </Select>
        )}</Field>
        {form.kind === 'rest' ? (
          <>
            <Field label={t('loomc.create.base_url')}>{(p) => <Input {...p} dir="ltr" value={form.base_url} onChange={(e) => setForm({ ...form, base_url: e.target.value })} />}</Field>
            <Field label={t('loomc.create.auth')}>{(p) => (
              <Select {...p} value={form.auth} onChange={(e) => setForm({ ...form, auth: e.target.value })}><option value="bearer">Bearer</option><option value="header">X-API-Key</option><option value="none">—</option></Select>
            )}</Field>
            <Field label={t('loomc.create.secret')}>{(p) => <Input {...p} type="password" autoComplete="off" dir="ltr" value={form.secret} onChange={(e) => setForm({ ...form, secret: e.target.value })} />}</Field>
            <Field label={t('loomc.create.paths')} error={parseJson(form.paths) === undefined ? t('loomc.mapping.invalid_json') : null}>{(p) => <Textarea {...p} dir="ltr" rows={4} value={form.paths} onChange={(e) => setForm({ ...form, paths: e.target.value })} />}</Field>
          </>
        ) : null}
        <div className="md:col-span-2"><Button disabled={!form.name || busy !== null} onClick={create}>{t('loomc.create.submit')}</Button></div>
      </div>
    </Card>
  );
}

function ConnectionDetail({ base, id }: { base: string; id: string }) {
  const { t } = useI18n();
  const path = `${base}/connections/${id}`;
  const r = useApiQuery<any>(['loom-connection', path], path);
  const { call, busy } = useCall([['loom-connection', path], ['loom-connections', base]]);
  const [entity, setEntity] = useState<string>('offerings');
  const [file, setFile] = useState<File | null>(null);
  const [m, setM] = useState<any>(null);
  if (r.isLoading) return <LoadingState rows={2} />;
  if (r.error) return <ErrorState error={r.error} onRetry={() => r.refetch()} />;
  const c = r.data;
  const mapping = m ?? {
    timezone: c.mapping?.timezone ?? 'Asia/Riyadh', currency: c.mapping?.currency ?? 'SAR', money_unit: c.mapping?.money_unit ?? 'major',
    columns: JSON.stringify(c.mapping?.columns ?? {}, null, 2), status_map: JSON.stringify(c.mapping?.status_map ?? { completed: 'fulfilled', cancelled: 'cancelled_customer' }, null, 2),
    revenue_basis: c.mapping?.revenue_basis ?? { amounts_include_tax: true, subtract_refunds: true, total_is_after_discount: true },
  };
  const setMap = (p: Record<string, unknown>) => setM({ ...mapping, ...p });
  const act = (a: string) => call(a, path, 'POST', { action: a });
  async function saveMapping() {
    const columns = parseJson(mapping.columns), status_map = parseJson(mapping.status_map);
    if (columns === undefined || status_map === undefined) return;
    await call('mapping', `${path}/mapping`, 'PUT', { timezone: mapping.timezone, currency: mapping.currency, money_unit: mapping.money_unit, columns, status_map, revenue_basis: mapping.revenue_basis }, t('states.saved'));
    setM(null);
  }
  async function upload() {
    if (!file) return;
    const content = await file.text();
    await call('upload', `${path}/files`, 'POST', { entity, filename: file.name, content });
    setFile(null);
  }
  const review = c.review ?? {};
  return (
    <div className="mt-3 flex flex-col gap-3 border-t border-line pt-3">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => act('test')}>{t('loomc.actions.test')}</Button>
        <Button size="sm" disabled={busy !== null || c.status === 'paused'} onClick={() => act('sync')}>{t('loomc.actions.sync')}</Button>
        {c.status === 'paused' ? <Button size="sm" variant="ghost" onClick={() => act('resume')}>{t('loomc.actions.resume')}</Button> : <Button size="sm" variant="ghost" onClick={() => act('pause')}>{t('loomc.actions.pause')}</Button>}
        {c.kind === 'rest' ? <Button size="sm" variant="ghost" disabled={busy !== null} onClick={async () => { const x = await call<any>('rotate', path, 'PATCH', { rotate_ingest_secret: true }); if (x?.ingest_secret) window.prompt(t('loomc.create.ingest_secret'), x.ingest_secret); }}>{t('loomc.actions.rotate')}</Button> : null}
      </div>
      {c.ingest_path ? <p className="text-xs text-ink-muted" dir="ltr">POST {c.ingest_path}</p> : null}

      <section>
        <h4 className="font-semibold">{t('loomc.review.title')}</h4>
        {review.snapshot_at ? (
          <div className="text-sm">
            <p>{t('loomc.review.quality')}: <Badge tone={review.quality?.overall === 'ok' ? 'ok' : review.quality?.overall === 'limited' ? 'warn' : 'danger'}>{review.quality?.overall}</Badge></p>
            <p className="text-xs text-ink-muted" dir="ltr">{Object.entries(review.counts ?? {}).filter(([, v]) => (v as number) > 0).map(([k, v]) => `${k}: ${v}`).join(' · ')}</p>
            {review.blockers?.length ? <Alert tone="warn" title={t('loomc.review.blockers')}><ul className="list-disc ps-5">{review.blockers.map((b: string) => <li key={b}>{t(`loomc.review.blocker.${b}`)}</li>)}</ul></Alert> : <p className="text-ok">{t('loomc.review.ready')}</p>}
          </div>
        ) : null}
        <div className="mt-2 flex gap-2">
          <Button size="sm" disabled={c.review_status !== 'pending_review' || busy !== null} onClick={() => call('approve', `${path}/review`, 'POST', { decision: 'approve' }, t('states.saved'))}>{t('loomc.review.approve')}</Button>
          <Button size="sm" variant="ghost" disabled={busy !== null || ['rejected', 'not_required'].includes(c.review_status)} onClick={() => call('reject', `${path}/review`, 'POST', { decision: 'reject' })}>{t('loomc.review.reject')}</Button>
        </div>
      </section>

      <section className="grid gap-2 md:grid-cols-3">
        <h4 className="font-semibold md:col-span-3">{t('loomc.mapping.title')}</h4>
        {c.revenue_basis_text ? <p className="text-xs text-ink-muted md:col-span-3" dir="ltr">{t('loomc.mapping.basis', { text: c.revenue_basis_text })}</p> : null}
        <Field label={t('loomc.mapping.timezone')}>{(p) => <Input {...p} dir="ltr" value={mapping.timezone} onChange={(e) => setMap({ timezone: e.target.value })} />}</Field>
        <Field label={t('loomc.mapping.currency')}>{(p) => <Input {...p} dir="ltr" maxLength={3} value={mapping.currency} onChange={(e) => setMap({ currency: e.target.value.toUpperCase() })} />}</Field>
        <Field label={t('loomc.mapping.money_unit')}>{(p) => (
          <Select {...p} value={mapping.money_unit} onChange={(e) => setMap({ money_unit: e.target.value })}><option value="major">{t('loomc.mapping.major')}</option><option value="minor">{t('loomc.mapping.minor')}</option></Select>
        )}</Field>
        <Field className="md:col-span-3" label={t('loomc.mapping.columns')} error={parseJson(mapping.columns) === undefined ? t('loomc.mapping.invalid_json') : null}>{(p) => <Textarea {...p} dir="ltr" rows={3} value={mapping.columns} onChange={(e) => setMap({ columns: e.target.value })} />}</Field>
        <Field className="md:col-span-3" label={t('loomc.mapping.status_map')} error={parseJson(mapping.status_map) === undefined ? t('loomc.mapping.invalid_json') : null}>{(p) => <Textarea {...p} dir="ltr" rows={3} value={mapping.status_map} onChange={(e) => setMap({ status_map: e.target.value })} />}</Field>
        <Checkbox label={t('loomc.mapping.include_tax')} checked={mapping.revenue_basis.amounts_include_tax} onChange={(v) => setMap({ revenue_basis: { ...mapping.revenue_basis, amounts_include_tax: v } })} />
        <Checkbox label={t('loomc.mapping.subtract_refunds')} checked={mapping.revenue_basis.subtract_refunds} onChange={(v) => setMap({ revenue_basis: { ...mapping.revenue_basis, subtract_refunds: v } })} />
        <Checkbox label={t('loomc.mapping.after_discount')} checked={mapping.revenue_basis.total_is_after_discount} onChange={(v) => setMap({ revenue_basis: { ...mapping.revenue_basis, total_is_after_discount: v } })} />
        <div className="md:col-span-3"><Button size="sm" disabled={busy !== null} onClick={saveMapping}>{t('loomc.mapping.save')}</Button></div>
      </section>

      {c.kind === 'csv_import' ? (
        <section className="flex flex-col gap-2">
          <h4 className="font-semibold">{t('loomc.files.title')}</h4>
          <div className="flex flex-wrap items-end gap-2">
            <Field label={t('loomc.files.entity')}>{(p) => <Select {...p} value={entity} onChange={(e) => setEntity(e.target.value)}>{ENTITIES.map((x) => <option key={x} value={x}>{x}</option>)}</Select>}</Field>
            <input type="file" accept=".csv,text/csv" aria-label={t('loomc.files.choose')} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            <Button size="sm" disabled={!file || busy !== null} onClick={upload}>{t('loomc.files.upload')}</Button>
          </div>
          <ul className="text-xs">
            {c.files.map((f: any) => (
              <li key={f.id} className="flex flex-wrap gap-2">
                <span dir="ltr">{f.entity} v{f.version} · {f.filename}</span>
                <Badge tone={f.status === 'invalid' ? 'danger' : f.status === 'applied' ? 'ok' : 'neutral'}>{t(`loomc.files.${f.status}`)}</Badge>
                <span>{t('loomc.files.rows', { n: f.row_count })}</span>
                {f.errors?.length ? <span className="text-danger" dir="ltr">{f.errors.slice(0, 3).map((e: any) => `${e.row}:${e.field} ${e.code}`).join(' · ')}</span> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section>
        <h4 className="font-semibold">{t('loomc.links.title')}</h4>
        {c.links.length ? (
          <ul className="text-xs">
            {c.links.map((l: any) => (
              <li key={l.id} className="flex flex-wrap items-center gap-2">
                <span dir="ltr">{l.entity}: {l.source_id_a} ↔ {l.source_id_b} ({l.reason}, {Math.round(l.confidence * 100)}%)</span>
                <Badge>{l.status}</Badge>
                {l.status === 'suggested' ? (
                  <>
                    <Button size="sm" variant="ghost" onClick={() => call('link', `${path}/links`, 'POST', { link_id: l.id, status: 'confirmed' })}>{t('loomc.links.confirm')}</Button>
                    <Button size="sm" variant="ghost" onClick={() => call('link', `${path}/links`, 'POST', { link_id: l.id, status: 'rejected' })}>{t('loomc.links.reject')}</Button>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        ) : <p className="text-xs text-ink-muted">{t('loomc.links.none')}</p>}
      </section>
    </div>
  );
}

export function LoomWebhooksPanel({ base, tz = 'Asia/Riyadh' }: { base: string; tz?: string }) {
  const { t, locale } = useI18n();
  const r = useApiQuery<any>(['loom-webhooks', base], `${base}/webhooks`);
  const { call, busy } = useCall([['loom-webhooks', base]]);
  const [url, setUrl] = useState('https://');
  const [events, setEvents] = useState<string[]>(['opportunity.created', 'plan.ready']);
  const [secret, setSecret] = useState<string | null>(null);
  if (r.isLoading) return <LoadingState rows={2} />;
  if (r.error) return <ErrorState error={r.error} onRetry={() => r.refetch()} />;
  const d = r.data;
  return (
    <Card title={t('loomc.webhooks.title')}>
      <p className="mb-2 text-sm text-ink-muted">{t('loomc.webhooks.subtitle')}</p>
      {secret ? <Alert tone="warn" title={t('loomc.webhooks.secret_once')}><code dir="ltr" className="break-all">{secret}</code></Alert> : null}
      {d.endpoints.length ? (
        <ul className="flex flex-col gap-1 text-sm">
          {d.endpoints.map((e: any) => (
            <li key={e.id} className="flex flex-wrap items-center gap-2">
              <span dir="ltr">{e.url}</span>{e.events.map((x: string) => <Badge key={x}>{x}</Badge>)}
              {e.active ? <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => call('off', `${base}/webhooks/${e.id}`, 'DELETE')}>{t('loomc.webhooks.deactivate')}</Button> : <Badge tone="neutral">—</Badge>}
            </li>
          ))}
        </ul>
      ) : <p className="text-sm text-ink-muted">{t('loomc.webhooks.empty')}</p>}
      <div className="mt-3 flex flex-col gap-2 border-t border-line pt-3">
        <Field label={t('loomc.webhooks.url')}>{(p) => <Input {...p} dir="ltr" value={url} onChange={(e) => setUrl(e.target.value)} />}</Field>
        <div className="flex flex-wrap gap-3">{EVENTS.map((ev) => <Checkbox key={ev} label={ev} checked={events.includes(ev)} onChange={(v) => setEvents(v ? [...events, ev] : events.filter((x) => x !== ev))} />)}</div>
        <div><Button size="sm" disabled={busy !== null || !events.length} onClick={async () => { const x = await call<any>('add', `${base}/webhooks`, 'POST', { url, events }); if (x) setSecret(x.signing_secret); }}>{t('loomc.webhooks.add')}</Button></div>
      </div>
      {d.deliveries.length ? (
        <div className="mt-3">
          <h4 className="font-semibold">{t('loomc.webhooks.deliveries')}</h4>
          <ul className="text-xs">
            {d.deliveries.map((x: any) => (
              <li key={x.id} className="flex flex-wrap gap-2">
                <span dir="ltr">{x.event_type}</span>
                <Badge tone={x.status === 'delivered' ? 'ok' : x.status === 'failed' ? 'danger' : 'warn'}>{t(`loomc.webhooks.status.${x.status}`)}</Badge>
                <span>{t('loomc.webhooks.attempts')}: {x.attempts}{x.last_status ? ` · HTTP ${x.last_status}` : ''}</span>
                <span>{formatDateTime(x.created_at, { locale, tz })}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Card>
  );
}

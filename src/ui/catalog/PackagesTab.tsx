'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Archive, ArrowDown, ArrowUp, Package, Plus, X } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { api } from '../api';
import { useApiQuery, useUnsavedChangesWarning } from '../hooks';
import { Button, IconButton } from '../components/button';
import { Checkbox, Field, LocalizedInput, MoneyInput, Select } from '../components/form';
import { Badge, EmptyState, ErrorState, LoadingState } from '../components/feedback';
import { Card } from '../components/layout';
import { ConfirmDialog, Drawer } from '../components/overlay';
import { useToast } from '../components/toast';
import { useAccess } from '../shell/access-context';
import { useFmt } from '../commerce/common';
import { ApiErrorBox } from './common';
import type { ServiceRow } from './ServicesPage';

type Pkg = { id: string; name_ar: string | null; name_en: string | null; description_ar: string | null; description_en: string | null; price_minor: number; is_active: boolean; is_visible: boolean; service_ids: string[] };

/** Packages bundle 2–10 services at one price. The API supports create and archive (no edit). */
export function PackagesTab() {
  const { t, pick } = useI18n();
  const access = useAccess();
  const qc = useQueryClient();
  const toast = useToast();
  const { money } = useFmt();
  const list = useApiQuery<Pkg[]>(['packages', access.slug], access.api('/packages'));
  const services = useApiQuery<ServiceRow[]>(['services', access.slug, ''], access.api('/services'));
  const [creating, setCreating] = useState(false);
  const [archiveId, setArchiveId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const canEdit = access.can('catalog.edit') && !access.readOnly;
  const svcName = (id: string) => { const s = services.data?.find((x) => x.id === id); return s ? pick(s.name_ar, s.name_en) : '…'; };
  const sumOf = (ids: string[]) => ids.reduce((a, id) => a + (services.data?.find((x) => x.id === id)?.price_minor ?? 0), 0);

  async function archive() {
    setBusy(true); setErr(null);
    try {
      await api(access.api(`/packages/${archiveId}`), { method: 'DELETE' });
      setArchiveId(null);
      toast({ tone: 'ok', text: t('catalog_team.packages.archived') });
      await qc.invalidateQueries({ queryKey: ['packages', access.slug] });
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-ink-muted">{t('catalog_team.packages.hint')}</p>
        {canEdit ? <Button icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>{t('catalog_team.packages.new')}</Button> : null}
      </div>
      <ApiErrorBox err={err} />
      {list.isLoading ? <LoadingState rows={3} /> : list.error ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : !list.data?.length ? (
        <EmptyState icon={<Package className="size-8" aria-hidden />} title={t('catalog_team.packages.empty')} hint={t('catalog_team.packages.empty_hint')} />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {list.data.map((p) => {
            const sum = sumOf(p.service_ids);
            return (
              <Card key={p.id} title={pick(p.name_ar, p.name_en)} actions={canEdit ? <IconButton label={t('actions.archive')} onClick={() => setArchiveId(p.id)}><Archive className="size-4" /></IconButton> : null}>
                <div className="flex flex-col gap-2 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-lg font-semibold" dir="ltr">{money(p.price_minor)}</span>
                    {sum > p.price_minor ? <span className="text-xs text-ink-muted">{t('catalog_team.packages.instead_of')} <s dir="ltr">{money(sum)}</s></span> : null}
                    {!p.is_active ? <Badge>{t('fields.inactive')}</Badge> : null}
                    {!p.is_visible ? <Badge>{t('fields.hidden')}</Badge> : null}
                  </div>
                  {pick(p.description_ar, p.description_en) ? <p className="text-ink-muted">{pick(p.description_ar, p.description_en)}</p> : null}
                  <ol className="list-decimal ps-5">{p.service_ids.map((id) => <li key={id}>{svcName(id)}</li>)}</ol>
                </div>
              </Card>
            );
          })}
        </div>
      )}
      {creating ? <PackageDrawer services={services.data ?? []} onClose={() => setCreating(false)} /> : null}
      <ConfirmDialog open={!!archiveId} onClose={() => setArchiveId(null)} onConfirm={archive} loading={busy} danger
        title={t('catalog_team.packages.archive_title')} body={t('catalog_team.packages.archive_body')} confirmLabel={t('actions.archive')} />
    </div>
  );
}

function PackageDrawer({ services, onClose }: { services: ServiceRow[]; onClose: () => void }) {
  const { t, pick } = useI18n();
  const access = useAccess();
  const qc = useQueryClient();
  const toast = useToast();
  const { money } = useFmt();
  const [name, setName] = useState<{ ar?: string; en?: string }>({});
  const [desc, setDesc] = useState<{ ar?: string; en?: string }>({});
  const [price, setPrice] = useState<number | null>(null);
  const [ids, setIds] = useState<string[]>([]);
  const [pickId, setPickId] = useState('');
  const [active, setActive] = useState(true);
  const [visible, setVisible] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const dirty = !!(name.ar || name.en || ids.length || price != null);
  useUnsavedChangesWarning(dirty);
  const available = services.filter((s) => !s.archived_at && !ids.includes(s.id));
  const sum = ids.reduce((a, id) => a + (services.find((s) => s.id === id)?.price_minor ?? 0), 0);
  const move = (i: number, d: -1 | 1) => { const a = [...ids]; const j = i + d; if (j < 0 || j >= a.length) return; [a[i], a[j]] = [a[j]!, a[i]!]; setIds(a); };

  async function save() {
    setBusy(true); setErr(null);
    try {
      await api(access.api('/packages'), { body: {
        name_ar: name.ar?.trim() || null, name_en: name.en?.trim() || null, description_ar: desc.ar?.trim() || null, description_en: desc.en?.trim() || null,
        price_minor: price ?? -1, service_ids: ids, is_active: active, is_visible: visible,
      } });
      toast({ tone: 'ok', text: t('catalog_team.packages.created') });
      await qc.invalidateQueries({ queryKey: ['packages', access.slug] });
      onClose();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }

  return (
    <Drawer open onClose={onClose} title={t('catalog_team.packages.new')} footer={<>
      <Button variant="ghost" onClick={onClose}>{t('actions.cancel')}</Button>
      <Button loading={busy} disabled={ids.length < 2} onClick={save}>{t('actions.create')}</Button>
    </>}>
      <div className="flex flex-col gap-4">
        <ApiErrorBox err={err} />
        <LocalizedInput label={t('fields.name')} required value={name} onChange={setName} />
        <LocalizedInput label={t('fields.description')} multiline maxLength={4000} value={desc} onChange={setDesc} />
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">{t('catalog_team.packages.services')} <span className="text-xs font-normal text-ink-muted">({t('catalog_team.packages.services_hint')})</span></span>
          {ids.length ? (
            <ol className="flex flex-col gap-1">
              {ids.map((id, i) => {
                const s = services.find((x) => x.id === id);
                return (
                  <li key={id} className="flex items-center gap-2 rounded-lg border border-line px-2 py-1 text-sm">
                    <span className="w-5 text-center text-xs text-ink-muted">{i + 1}</span>
                    <span className="min-w-0 flex-1 truncate">{s ? pick(s.name_ar, s.name_en) : id}</span>
                    <span className="text-xs text-ink-muted" dir="ltr">{s ? money(s.price_minor) : ''}</span>
                    <IconButton label={t('actions.move_up')} disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp className="size-4" /></IconButton>
                    <IconButton label={t('actions.move_down')} disabled={i === ids.length - 1} onClick={() => move(i, 1)}><ArrowDown className="size-4" /></IconButton>
                    <IconButton label={t('actions.delete')} onClick={() => setIds(ids.filter((x) => x !== id))}><X className="size-4" /></IconButton>
                  </li>
                );
              })}
            </ol>
          ) : null}
          {ids.length < 10 ? (
            <div className="flex gap-2">
              <Select aria-label={t('catalog_team.packages.add_service')} value={pickId} onChange={(e) => setPickId(e.target.value)}>
                <option value="">{t('catalog_team.packages.choose_service')}</option>
                {available.map((s) => <option key={s.id} value={s.id}>{pick(s.name_ar, s.name_en)}</option>)}
              </Select>
              <Button variant="outline" disabled={!pickId} onClick={() => { setIds([...ids, pickId]); setPickId(''); }}>{t('actions.add')}</Button>
            </div>
          ) : null}
          {sum ? <p className="text-xs text-ink-muted">{t('catalog_team.packages.sum', { sum: money(sum) })}</p> : null}
        </div>
        <Field label={t('catalog_team.packages.price')} required>{(fp) => <MoneyInput {...fp} value={price} onChange={setPrice} />}</Field>
        <Checkbox label={t('fields.active')} checked={active} onChange={setActive} />
        <Checkbox label={t('catalog_ui.show_in_store')} checked={visible} onChange={setVisible} />
      </div>
    </Drawer>
  );
}

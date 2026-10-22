'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Archive, ArchiveRestore, ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { api, ApiError } from '../api';
import { useApiQuery, useErrorMessage, useUnsavedChangesWarning } from '../hooks';
import { Button, IconButton } from '../components/button';
import { Checkbox, Field, FormErrorSummary, Input, LocalizedInput, MoneyInput, Select } from '../components/form';
import { Alert, Badge, ErrorState, LoadingState } from '../components/feedback';
import { ConfirmDialog, Drawer } from '../components/overlay';
import { useToast } from '../components/toast';
import { useAccess } from '../shell/access-context';
import { ImageUpload } from '../workspace/ImageUpload';
import { parseNum, StockBadge } from './common';
import { StockPanel } from './StockPanel';

type Variant = {
  id?: string; name_ar?: string | null; name_en?: string | null; sku?: string | null; barcode?: string | null; price_minor: number | null;
  cost_minor?: number | null; is_active?: boolean; is_default?: boolean; initial_stock?: string; low_stock_threshold?: string;
  inventory_item_id?: string | null; on_hand?: number; reserved?: number; available?: number; low_stock?: boolean;
};
type Product = {
  id: string; version: number; status: string; name_ar: string | null; name_en: string | null; description_ar: string | null; description_en: string | null;
  category_id: string | null; is_visible: boolean; hide_when_out_of_stock: boolean; max_per_order: number; returnable: boolean;
  image_asset_ids: string[]; variants: Array<Variant & { id: string; low_stock_threshold: number | null }>;
};

function emptyForm() {
  return {
    name: { ar: '', en: '' } as { ar?: string; en?: string }, description: { ar: '', en: '' } as { ar?: string; en?: string },
    category_id: '', status: 'active', is_visible: true, hide_when_out_of_stock: false, max_per_order: '10', returnable: true,
    images: [] as string[], variants: [{ price_minor: null, initial_stock: '0', low_stock_threshold: '' }] as Variant[],
  };
}

function formFrom(p: Product | undefined) {
  if (!p) return emptyForm();
  return {
    name: { ar: p.name_ar ?? '', en: p.name_en ?? '' }, description: { ar: p.description_ar ?? '', en: p.description_en ?? '' },
    category_id: p.category_id ?? '', status: p.status, is_visible: p.is_visible, hide_when_out_of_stock: p.hide_when_out_of_stock,
    max_per_order: String(p.max_per_order), returnable: p.returnable, images: p.image_asset_ids,
    variants: p.variants.map((v) => ({ ...v, low_stock_threshold: v.low_stock_threshold == null ? '' : String(v.low_stock_threshold) })) as Variant[],
  };
}

export function ProductDrawer({ productId, onClose }: { productId: string | 'new'; onClose: () => void }) {
  const { t } = useI18n();
  const access = useAccess();
  const isNew = productId === 'new';
  const q = useApiQuery<Product>(['product', access.slug, productId], isNew ? null : access.api(`/products/${productId}`));
  if (!isNew && (q.isLoading || q.error || !q.data)) {
    return (
      <Drawer open onClose={onClose} title={t('commerce.products.edit')} wide>
        {q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : <LoadingState rows={5} />}
      </Drawer>
    );
  }
  // Remount the form when the product version changes (after a save); stock figures are read live from the prop.
  return <ProductForm key={q.data ? `${q.data.id}:${q.data.version}` : 'new'} product={q.data} onClose={onClose} refetch={() => q.refetch()} />;
}

function ProductForm({ product, onClose, refetch }: { product: Product | undefined; onClose: () => void; refetch: () => void }) {
  const { t, pick } = useI18n();
  const access = useAccess();
  const msg = useErrorMessage();
  const toast = useToast();
  const qc = useQueryClient();
  const isNew = !product;
  const productId = product?.id;
  const canEdit = access.can('catalog.edit');
  const canCost = access.can('costs.view');
  const cats = useApiQuery<Array<{ id: string; name_ar: string | null; name_en: string | null }>>(['categories', access.slug, 'product'], canEdit ? access.api('/categories?kind=product') : null);
  const [form, setForm] = useState(() => formFrom(product));
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [confirmArchive, setConfirmArchive] = useState(false);
  useUnsavedChangesWarning(dirty);

  const set = (patch: Partial<ReturnType<typeof emptyForm>>) => { setForm((f) => ({ ...f, ...patch })); setDirty(true); };
  const setVariant = (i: number, patch: Partial<Variant>) => set({ variants: form.variants.map((v, j) => (j === i ? { ...v, ...patch } : v)) });
  const moveVariant = (i: number, d: -1 | 1) => {
    const vs = [...form.variants]; const j = i + d;
    if (j < 1 || j >= vs.length || i < 1) return; // the default variant stays first
    [vs[i], vs[j]] = [vs[j]!, vs[i]!]; set({ variants: vs });
  };

  async function save() {
    setBusy(true); setErr(null);
    const variants = form.variants.map((v) => ({
      ...(v.id ? { id: v.id } : {}), name_ar: v.name_ar || null, name_en: v.name_en || null, sku: v.sku?.trim() || null, barcode: v.barcode?.trim() || null,
      price_minor: v.price_minor ?? -1, is_active: v.is_active ?? true,
      ...(canCost ? { cost_minor: v.cost_minor ?? null } : {}),
      ...(!v.id ? { initial_stock: Math.max(0, Math.trunc(parseNum(v.initial_stock ?? '') ?? 0)) } : {}),
      low_stock_threshold: parseNum(v.low_stock_threshold ?? ''),
    }));
    const body = {
      name_ar: form.name.ar || null, name_en: form.name.en || null, description_ar: form.description.ar || null, description_en: form.description.en || null,
      category_id: form.category_id || null, is_visible: form.is_visible, hide_when_out_of_stock: form.hide_when_out_of_stock,
      max_per_order: Math.trunc(parseNum(form.max_per_order) ?? 10), returnable: form.returnable, image_asset_ids: form.images, variants,
      ...(form.status !== 'archived' ? { status: form.status } : {}),
    };
    try {
      if (isNew) await api(access.api('/products'), { body });
      else await api(access.api(`/products/${productId}`), { method: 'PATCH', body: { ...body, version: product!.version } });
      setDirty(false);
      toast({ tone: 'ok', text: t(isNew ? 'commerce.products.created' : 'commerce.products.saved') });
      qc.invalidateQueries({ queryKey: ['products', access.slug] });
      if (isNew) onClose(); else refetch();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }

  async function archive(archived: boolean) {
    setBusy(true); setErr(null);
    try {
      await api(access.api(`/products/${productId}/archive`), { body: { archived } });
      qc.invalidateQueries({ queryKey: ['products', access.slug] });
      setConfirmArchive(false);
      refetch();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }

  const p = product;
  const archived = p?.status === 'archived';
  const readOnly = !canEdit || archived || access.readOnly;
  const issues = err instanceof ApiError && err.code === 'validation_failed' ? (err.details?.issues as Array<{ path: string; message: string }>) : undefined;
  const title = isNew ? t('commerce.products.new') : (p ? pick(p.name_ar, p.name_en) : t('commerce.products.edit'));

  return (
    <Drawer open onClose={onClose} title={title} wide footer={readOnly ? undefined : (
      <>
        {!isNew ? <Button variant="ghost" icon={<Archive className="size-4" />} onClick={() => setConfirmArchive(true)}>{t('commerce.products.archive')}</Button> : null}
        <Button variant="ghost" onClick={onClose}>{t('actions.cancel')}</Button>
        <Button loading={busy} onClick={save}>{t('actions.save')}</Button>
      </>
    )}>
      {(
        <div className="flex flex-col gap-6">
          <FormErrorSummary message={err ? msg(err) : null} issues={issues} />
          {archived ? (
            <Alert tone="warn" title={t('commerce.products.archived_note')}>
              {canEdit ? <Button className="mt-2" size="sm" variant="outline" icon={<ArchiveRestore className="size-4" />} loading={busy} onClick={() => archive(false)}>{t('commerce.products.restore')}</Button> : null}
            </Alert>
          ) : null}
          <fieldset disabled={readOnly} className="flex flex-col gap-4">
            <legend className="mb-2 font-semibold">{t('commerce.products.section_basic')}</legend>
            <LocalizedInput label={t('commerce.products.name')} required value={form.name} onChange={(v) => set({ name: v })} />
            <LocalizedInput label={t('commerce.products.description')} multiline maxLength={4000} value={form.description} onChange={(v) => set({ description: v })} />
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t('commerce.products.category')}>{(fp) => (
                <Select {...fp} value={form.category_id} onChange={(e) => set({ category_id: e.target.value })}>
                  <option value="">{t('commerce.products.no_category')}</option>
                  {cats.data?.map((c) => <option key={c.id} value={c.id}>{pick(c.name_ar, c.name_en)}</option>)}
                </Select>
              )}</Field>
              {!archived ? (
                <Field label={t('commerce.products.status_field')}>{(fp) => (
                  <Select {...fp} value={form.status} onChange={(e) => set({ status: e.target.value })}>
                    <option value="active">{t('commerce.products.status.active')}</option>
                    <option value="draft">{t('commerce.products.status.draft')}</option>
                  </Select>
                )}</Field>
              ) : null}
            </div>
          </fieldset>

          <fieldset disabled={readOnly} className="flex flex-col gap-3">
            <legend className="mb-2 font-semibold">{t('commerce.products.section_variants')}</legend>
            {!isNew ? <p className="text-xs text-ink-muted">{t('commerce.products.price_change_note')}</p> : null}
            {form.variants.map((v0, i) => {
              const live = v0.id ? product?.variants.find((x) => x.id === v0.id) : undefined;
              const v = live ? { ...v0, on_hand: live.on_hand, reserved: live.reserved, available: live.available, low_stock: live.low_stock } : v0;
              return (
              <div key={v.id ?? `new-${i}`} className="flex flex-col gap-3 rounded-xl border border-line p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{i === 0 ? t('commerce.products.default_variant') : `${t('commerce.products.variant')} ${i + 1}`}</span>
                    {v.is_active === false ? <Badge>{t('commerce.products.inactive_variant')}</Badge> : null}
                    {v.id ? <StockBadge available={v.available ?? 0} low={v.low_stock} /> : null}
                  </div>
                  {i > 0 && !readOnly ? (
                    <div className="flex items-center gap-1">
                      <IconButton label={t('actions.move_up')} disabled={i === 1} onClick={() => moveVariant(i, -1)}><ArrowUp className="size-4" /></IconButton>
                      <IconButton label={t('actions.move_down')} disabled={i === form.variants.length - 1} onClick={() => moveVariant(i, 1)}><ArrowDown className="size-4" /></IconButton>
                      {v.id ? (
                        <Button size="sm" variant="ghost" onClick={() => setVariant(i, { is_active: v.is_active === false })}>{v.is_active === false ? t('commerce.products.reactivate') : t('commerce.products.deactivate')}</Button>
                      ) : <IconButton label={t('actions.delete')} onClick={() => set({ variants: form.variants.filter((_, j) => j !== i) })}><Trash2 className="size-4" /></IconButton>}
                    </div>
                  ) : null}
                </div>
                {i > 0 || form.variants.length > 1 ? (
                  <LocalizedInput label={t('commerce.products.variant_name')} value={{ ar: v.name_ar ?? '', en: v.name_en ?? '' }} onChange={(x) => setVariant(i, { name_ar: x.ar, name_en: x.en })} />
                ) : null}
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label={t('commerce.products.price')} required>{(fp) => <MoneyInput {...fp} value={v.price_minor} onChange={(m) => setVariant(i, { price_minor: m })} />}</Field>
                  {canCost ? <Field label={t('commerce.products.cost')} hint={t('commerce.products.cost_hint')}>{(fp) => <MoneyInput {...fp} value={v.cost_minor} onChange={(m) => setVariant(i, { cost_minor: m })} />}</Field> : null}
                  <Field label={t('commerce.products.sku')}>{(fp) => <Input {...fp} dir="ltr" maxLength={64} value={v.sku ?? ''} onChange={(e) => setVariant(i, { sku: e.target.value })} />}</Field>
                  <Field label={t('commerce.products.barcode')}>{(fp) => <Input {...fp} dir="ltr" maxLength={64} value={v.barcode ?? ''} onChange={(e) => setVariant(i, { barcode: e.target.value })} />}</Field>
                  {!v.id ? <Field label={t('commerce.products.initial_stock')}>{(fp) => <Input {...fp} inputMode="numeric" dir="ltr" value={v.initial_stock ?? ''} onChange={(e) => setVariant(i, { initial_stock: e.target.value })} />}</Field> : null}
                  <Field label={t('commerce.products.low_threshold')}>{(fp) => <Input {...fp} inputMode="numeric" dir="ltr" value={v.low_stock_threshold ?? ''} onChange={(e) => setVariant(i, { low_stock_threshold: e.target.value })} />}</Field>
                </div>
                {v.id && v.inventory_item_id ? (
                  <details className="rounded-lg bg-luma-50/60 p-2">
                    <summary className="cursor-pointer text-sm font-medium">{t('commerce.products.stock_actions')}</summary>
                    <div className="mt-2">
                      <StockPanel itemId={v.inventory_item_id} unit="piece" onHand={v.on_hand ?? 0} reserved={v.reserved ?? 0}
                        canManage={!access.readOnly && access.can('catalog.edit', 'inventory.manage')} onChanged={() => { refetch(); qc.invalidateQueries({ queryKey: ['products', access.slug] }); }} />
                    </div>
                  </details>
                ) : null}
              </div>
              );
            })}
            {!readOnly && form.variants.length < 50 ? (
              <Button variant="outline" size="sm" icon={<Plus className="size-4" />} className="self-start" onClick={() => set({ variants: [...form.variants, { price_minor: form.variants[0]?.price_minor ?? null, initial_stock: '0', low_stock_threshold: '' }] })}>{t('commerce.products.add_variant')}</Button>
            ) : null}
          </fieldset>

          <fieldset disabled={readOnly} className="flex flex-col gap-3">
            <legend className="mb-2 font-semibold">{t('commerce.products.section_selling')}</legend>
            <Checkbox label={t('commerce.products.visible')} checked={form.is_visible} onChange={(v) => set({ is_visible: v })} disabled={readOnly} />
            <Checkbox label={t('commerce.products.hide_when_out')} checked={form.hide_when_out_of_stock} onChange={(v) => set({ hide_when_out_of_stock: v })} disabled={readOnly} />
            <Checkbox label={t('commerce.products.returnable')} description={t('commerce.products.returnable_hint')} checked={form.returnable} onChange={(v) => set({ returnable: v })} disabled={readOnly} />
            <Field label={t('commerce.products.max_per_order')} className="max-w-xs">{(fp) => <Input {...fp} inputMode="numeric" dir="ltr" value={form.max_per_order} onChange={(e) => set({ max_per_order: e.target.value })} />}</Field>
          </fieldset>

          <fieldset disabled={readOnly} className="flex flex-col gap-3">
            <legend className="mb-1 font-semibold">{t('commerce.products.section_images')}</legend>
            <p className="text-xs text-ink-muted">{t('commerce.products.images_hint')}</p>
            <div className="flex flex-wrap gap-4">
              {form.images.map((id, i) => (
                <div key={id} className="flex flex-col items-center gap-1">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`/api/v1/media/${id}`} alt="" className="size-20 rounded-lg border border-line object-cover" />
                  {!readOnly ? (
                    <div className="flex">
                      <IconButton label={t('actions.move_up')} disabled={i === 0} onClick={() => { const a = [...form.images]; [a[i - 1], a[i]] = [a[i]!, a[i - 1]!]; set({ images: a }); }}><ArrowUp className="size-4" /></IconButton>
                      <IconButton label={t('actions.delete')} onClick={() => set({ images: form.images.filter((x) => x !== id) })}><Trash2 className="size-4" /></IconButton>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
            {!readOnly && form.images.length < 10 ? <ImageUpload slug={access.slug} purpose="product" value={null} onChange={(id) => id && set({ images: [...form.images, id] })} label={t('commerce.products.add_image')} /> : null}
          </fieldset>
        </div>
      )}
      <ConfirmDialog open={confirmArchive} onClose={() => setConfirmArchive(false)} onConfirm={() => archive(true)} loading={busy} danger
        title={t('commerce.products.archive')} body={t('commerce.products.archive_confirm')} confirmLabel={t('actions.archive')} />
    </Drawer>
  );
}

'use client';

import { useState } from 'react';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { Button, IconButton } from '../components/button';
import { Checkbox, Field, Input, LocalizedInput, Select, Switch, Textarea } from '../components/form';
import { Alert } from '../components/feedback';
import { cx } from '../components/cx';
import { ACTION_TYPES, BLOCKS, isSafeExternalUrl, makeBlock, MAX_CHILDREN, BLOCK_TYPES, type BlockAction, type PageBlock, type RichText } from '@/shared/builder/blocks';
import { plainToRich, richToPlain } from '@/shared/builder/richtext';
import { FIELD_SPECS, type FieldSpec, type RefKind } from './fields';
import { AssetAltEditor, ImagePicker } from './ImagePicker';
import { BlockIcon } from './Library';
import type { BuilderPage, CatalogRefs, RefWarning } from './types';

type Opt = { id: string; label: string; note?: string };

export function refOptions(kind: RefKind, refs: CatalogRefs, pages: BuilderPage[], pick: (ar?: string | null, en?: string | null) => string, t: (k: string) => string, categoryKind?: string): Opt[] {
  const note = (x: { archived?: boolean; is_visible?: boolean; is_active?: boolean; is_public?: boolean }) =>
    x.archived ? t('builder.status.archived') : x.is_visible === false || x.is_public === false ? t('builder.status.hidden') : x.is_active === false ? t('builder.status.inactive') : undefined;
  switch (kind) {
    case 'service': return refs.services.map((s) => ({ id: s.id, label: pick(s.name_ar, s.name_en), note: note(s) }));
    case 'product': return refs.products.map((s) => ({ id: s.id, label: pick(s.name_ar, s.name_en), note: s.archived ? t('builder.status.archived') : s.status !== 'active' ? t('builder.status.inactive') : !s.is_visible ? t('builder.status.hidden') : undefined }));
    case 'category': return refs.categories.filter((c) => !categoryKind || c.kind === categoryKind).map((s) => ({ id: s.id, label: pick(s.name_ar, s.name_en), note: note(s) }));
    case 'staff': return refs.staff.map((s) => ({ id: s.id, label: pick(s.display_name, s.display_name_en), note: note(s) }));
    case 'package': return refs.packages.map((s) => ({ id: s.id, label: pick(s.name_ar, s.name_en), note: note(s) }));
    case 'branch': return refs.branches.map((b) => ({ id: b.id, label: b.name, note: b.status !== 'active' ? t('builder.status.archived') : undefined }));
    case 'page': return pages.filter((p) => p.kind !== 'home').map((p) => ({ id: p.id, label: pick(p.title_ar, p.title_en), note: p.status !== 'active' ? t('builder.status.archived') : undefined }));
  }
}

const optLabel = (o: Opt) => (o.note ? `${o.label} (${o.note})` : o.label);

function RefMulti({ label, value, options, onChange, hint }: { label: string; value: string[]; options: Opt[]; onChange: (v: string[]) => void; hint: string }) {
  const { t } = useI18n();
  const [add, setAdd] = useState('');
  const byId = new Map(options.map((o) => [o.id, o]));
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium">{label}</span>
      {value.length ? (
        <ul className="flex flex-col gap-1">
          {value.map((id, i) => (
            <li key={id} className="flex items-center gap-1 rounded-md border border-line px-2 py-1 text-sm">
              <span className={cx('flex-1 truncate', !byId.has(id) && 'text-danger')}>{byId.get(id) ? optLabel(byId.get(id)!) : t('builder.status.missing')}</span>
              <IconButton label={t('builder.canvas.move_up')} disabled={i === 0} onClick={() => { const v = [...value]; [v[i - 1], v[i]] = [v[i]!, v[i - 1]!]; onChange(v); }} className="size-7"><ArrowUp className="size-3.5" /></IconButton>
              <IconButton label={t('builder.canvas.move_down')} disabled={i === value.length - 1} onClick={() => { const v = [...value]; [v[i + 1], v[i]] = [v[i]!, v[i + 1]!]; onChange(v); }} className="size-7"><ArrowDown className="size-3.5" /></IconButton>
              <IconButton label={t('builder.remove')} onClick={() => onChange(value.filter((x) => x !== id))} className="size-7 text-danger"><Trash2 className="size-3.5" /></IconButton>
            </li>
          ))}
        </ul>
      ) : <p className="text-xs text-ink-muted">{hint}</p>}
      <div className="flex gap-1">
        <Select aria-label={`${t('builder.add')}: ${label}`} value={add} onChange={(e) => setAdd(e.target.value)}>
          <option value="">{t('builder.choose')}</option>
          {options.filter((o) => !value.includes(o.id)).map((o) => <option key={o.id} value={o.id}>{optLabel(o)}</option>)}
        </Select>
        <Button size="sm" variant="outline" disabled={!add} onClick={() => { onChange([...value, add].slice(0, 50)); setAdd(''); }} icon={<Plus className="size-4" />}>{t('builder.add')}</Button>
      </div>
    </div>
  );
}

/** Plain-text editing of restricted rich text (paragraphs, ## headings, - lists). Local text keeps typing stable. */
function RichEditor({ label, value, onChange, blockId }: { label: string; value: RichText | undefined; onChange: (v: RichText) => void; blockId: string }) {
  const { t } = useI18n();
  const [lang, setLang] = useState<'ar' | 'en'>('ar');
  const [text, setText] = useState({ ar: richToPlain(value?.ar), en: richToPlain(value?.en) });
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <label htmlFor={`rich-${blockId}-${lang}`} className="text-sm font-medium">{label}</label>
        <div role="tablist" className="flex rounded-md bg-luma-100 p-0.5 text-xs">
          {(['ar', 'en'] as const).map((l) => <button key={l} role="tab" type="button" aria-selected={lang === l} onClick={() => setLang(l)} className={cx('rounded px-2 py-0.5', lang === l ? 'bg-white shadow-sm' : 'text-ink-muted')}>{l === 'ar' ? 'ع' : 'EN'}</button>)}
        </div>
      </div>
      <Textarea id={`rich-${blockId}-${lang}`} rows={6} dir={lang === 'ar' ? 'rtl' : 'ltr'} lang={lang} maxLength={6000} value={text[lang]}
        onChange={(e) => { const next = { ...text, [lang]: e.target.value }; setText(next); onChange({ ...(value ?? {}), [lang]: plainToRich(e.target.value) }); }} />
      <p className="text-xs text-ink-muted">{t('builder.rich_hint')}</p>
    </div>
  );
}

function ActionEditor({ action, onChange, refs, pages, pageBlocks, pick }: { action: BlockAction | undefined; onChange: (a: BlockAction | undefined) => void; refs: CatalogRefs; pages: BuilderPage[]; pageBlocks: PageBlock[]; pick: (a?: string | null, e?: string | null) => string }) {
  const { t, locale } = useI18n();
  const [url, setUrl] = useState(action?.type === 'external' ? action.url : '');
  const [urlErr, setUrlErr] = useState(false);
  const type = action?.type ?? '';
  const target = action && 'targetId' in action ? action.targetId ?? '' : '';
  const kindFor: Record<string, RefKind | null> = { service: 'service', product: 'product', category: 'category', staff: 'staff', page: 'page', start_booking: 'service', section: null, external: null };
  const opts = type && kindFor[type] ? refOptions(kindFor[type]!, refs, pages, pick, t) : [];
  const set = (ty: string, id?: string) => {
    if (!ty) return onChange(undefined);
    if (ty === 'start_booking') return onChange(id ? { type: 'start_booking', targetId: id } : { type: 'start_booking' });
    if (ty === 'external') { if (isSafeExternalUrl(url)) onChange({ type: 'external', url }); else onChange(undefined); return; }
    const first = id ?? (ty === 'section' ? pageBlocks[0]?.id : opts[0]?.id ?? (kindFor[ty] ? refOptions(kindFor[ty]!, refs, pages, pick, t)[0]?.id : undefined));
    if (!first) return onChange(undefined);
    onChange({ type: ty, targetId: first } as BlockAction);
  };
  return (
    <fieldset className="flex flex-col gap-2 rounded-lg border border-line p-3">
      <legend className="px-1 text-sm font-medium">{t('builder.action.title')}</legend>
      <Field label={t('builder.action.type')}>{(p) => (
        <Select {...p} value={type} onChange={(e) => set(e.target.value)}>
          <option value="">{t('builder.action.none')}</option>
          {ACTION_TYPES.map((a) => <option key={a} value={a}>{t(`builder.action.types.${a}`)}</option>)}
        </Select>
      )}</Field>
      {type && type !== 'external' && type !== 'section' ? (
        <Field label={t('builder.action.target')}>{(p) => (
          <Select {...p} value={target} onChange={(e) => set(type, e.target.value || undefined)}>
            {type === 'start_booking' ? <option value="">{t('builder.action.any_service')}</option> : null}
            {opts.map((o) => <option key={o.id} value={o.id}>{optLabel(o)}</option>)}
          </Select>
        )}</Field>
      ) : null}
      {type === 'section' ? (
        <Field label={t('builder.action.section')}>{(p) => (
          <Select {...p} value={target} onChange={(e) => set('section', e.target.value)}>
            {pageBlocks.map((b) => <option key={b.id} value={b.id}>{BLOCKS[b.type].label[locale]} · {b.id.slice(-4)}</option>)}
          </Select>
        )}</Field>
      ) : null}
      {type === 'external' || (!type && url) ? (
        <Field label={t('builder.action.url')} hint={t('builder.action.url_hint')} error={urlErr ? t('builder.action.url_invalid') : null}>{(p) => (
          <Input {...p} dir="ltr" inputMode="url" placeholder="https://" value={url} maxLength={2000}
            onChange={(e) => { const v = e.target.value.trim(); setUrl(v); const ok = isSafeExternalUrl(v); setUrlErr(!!v && !ok); if (ok) onChange({ type: 'external', url: v }); }} />
        )}</Field>
      ) : null}
    </fieldset>
  );
}

export type PropertiesProps = {
  slug: string;
  block: PageBlock;
  parent: PageBlock | null;
  pageBlocks: PageBlock[];
  refs: CatalogRefs;
  pages: BuilderPage[];
  warnings: RefWarning[];
  onChange: (fn: (b: PageBlock) => PageBlock, key?: string) => void;
  onSelect: (id: string | null) => void;
  onAssetsChange: (a: CatalogRefs['assets'][number]) => void;
};

/** Properties panel generated per block type from FIELD_SPECS + the registry. */
export function Properties({ slug, block, parent, pageBlocks, refs, pages, warnings, onChange, onSelect, onAssetsChange }: PropertiesProps) {
  const { t, locale, pick } = useI18n();
  const d = BLOCKS[block.type];
  const parsed = d.props.safeParse(block.props);
  const props = (parsed.success ? parsed.data : block.props) as Record<string, any>;
  const set = (key: string, v: unknown, coalesce = false) => onChange((b) => ({ ...b, props: { ...b.props, [key]: v } }), coalesce ? `${block.id}.${key}` : undefined);
  const fl = (key: string) => t(`builder.f.${key}`);
  const myWarnings = warnings.filter((w) => w.blockId === block.id);

  const field = (f: FieldSpec) => {
    switch (f.k) {
      case 'localized':
        return <LocalizedInput key={f.key} label={fl(f.key)} value={props[f.key]} maxLength={f.max ?? 160} multiline={f.multiline} onChange={(v) => set(f.key, v, true)} />;
      case 'rich':
        return <RichEditor key={f.key} blockId={block.id} label={fl(f.key)} value={props[f.key]} onChange={(v) => set(f.key, v, true)} />;
      case 'select':
        return <Field key={f.key} label={fl(f.key)}>{(p) => <Select {...p} value={String(props[f.key] ?? '')} onChange={(e) => set(f.key, e.target.value)}>{f.options.map((o) => <option key={o} value={o}>{t(`builder.o.${o}`)}</option>)}</Select>}</Field>;
      case 'number':
        return (
          <Field key={f.key} label={`${fl(f.key)}: ${props[f.key] ?? ''}`}>{(p) => (
            <input {...p} type="range" min={f.min} max={f.max} step={f.step ?? 1} value={Number(props[f.key] ?? f.min)} onChange={(e) => set(f.key, Number(e.target.value), true)} className="accent-luma-700" />
          )}</Field>
        );
      case 'boolean':
        return <Switch key={f.key} label={fl(f.key)} checked={!!props[f.key]} onChange={(v) => set(f.key, v)} />;
      case 'image': {
        const asset = refs.assets.find((a) => a.id === props[f.key]);
        const ownAlt = FIELD_SPECS[block.type].some((x) => x.key === 'alt');
        return (
          <div key={f.key} className="flex flex-col gap-2">
            <ImagePicker slug={slug} purpose={f.purpose} label={fl(f.key)} value={props[f.key]} assets={refs.assets} onUploaded={onAssetsChange} onChange={(id) => set(f.key, id)} />
            {!ownAlt && asset ? <AssetAltEditor key={asset.id} slug={slug} asset={asset} onSaved={onAssetsChange} /> : null}
          </div>
        );
      }
      case 'ref': {
        const opts = refOptions(f.ref, refs, pages, pick, t, f.categoryKind);
        return (
          <Field key={f.key} label={fl(f.key)}>{(p) => (
            <Select {...p} value={props[f.key] ?? ''} onChange={(e) => set(f.key, e.target.value || (f.nullable ? null : props[f.key]))}>
              {f.nullable ? <option value="">{f.ref === 'branch' ? t('builder.primary_branch') : t('builder.all')}</option> : null}
              {opts.map((o) => <option key={o.id} value={o.id}>{optLabel(o)}</option>)}
            </Select>
          )}</Field>
        );
      }
      case 'refs':
        return <RefMulti key={f.key} label={fl(f.key)} hint={t('builder.refs_auto')} value={props[f.key] ?? []} options={refOptions(f.ref, refs, pages, pick, t)} onChange={(v) => set(f.key, v)} />;
      case 'gallery': {
        const items = (props.items ?? []) as Array<{ image_asset_id: string; alt?: { ar?: string; en?: string }; caption?: { ar?: string; en?: string } }>;
        const setItems = (v: typeof items, c = false) => set('items', v, c);
        return (
          <div key={f.key} className="flex flex-col gap-2">
            <span className="text-sm font-medium">{fl('items')} ({items.length}/60)</span>
            <ul className="flex flex-col gap-2">
              {items.map((it, i) => (
                <li key={`${it.image_asset_id}-${i}`} className="flex flex-col gap-2 rounded-lg border border-line p-2">
                  <div className="flex items-center gap-2">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={`/api/v1/media/${it.image_asset_id}`} alt="" className="size-12 rounded object-cover" />
                    <span className="flex-1 text-xs text-ink-muted">#{i + 1}</span>
                    <IconButton label={t('builder.canvas.move_up')} disabled={i === 0} className="size-7" onClick={() => { const v = [...items]; [v[i - 1], v[i]] = [v[i]!, v[i - 1]!]; setItems(v); }}><ArrowUp className="size-3.5" /></IconButton>
                    <IconButton label={t('builder.canvas.move_down')} disabled={i === items.length - 1} className="size-7" onClick={() => { const v = [...items]; [v[i + 1], v[i]] = [v[i]!, v[i + 1]!]; setItems(v); }}><ArrowDown className="size-3.5" /></IconButton>
                    <IconButton label={t('builder.remove')} className="size-7 text-danger" onClick={() => setItems(items.filter((_, k) => k !== i))}><Trash2 className="size-3.5" /></IconButton>
                  </div>
                  <LocalizedInput label={fl('alt')} value={it.alt} onChange={(v) => setItems(items.map((x, k) => (k === i ? { ...x, alt: v } : x)), true)} />
                  <LocalizedInput label={fl('caption')} value={it.caption} onChange={(v) => setItems(items.map((x, k) => (k === i ? { ...x, caption: v } : x)), true)} />
                </li>
              ))}
            </ul>
            {items.length < 60 ? <ImagePicker slug={slug} purpose="gallery" label={t('builder.gallery_add')} value={null} assets={refs.assets} onUploaded={onAssetsChange} onChange={(id) => { if (id) setItems([...items, { image_asset_id: id }]); }} /> : null}
          </div>
        );
      }
      case 'faq': {
        const items = (props.items ?? []) as Array<{ q: { ar?: string; en?: string }; a: { ar?: string; en?: string } }>;
        const setItems = (v: typeof items, c = false) => set('items', v, c);
        return (
          <div key={f.key} className="flex flex-col gap-2">
            <span className="text-sm font-medium">{fl('faq_items')}</span>
            {items.map((it, i) => (
              <div key={i} className="flex flex-col gap-2 rounded-lg border border-line p-2">
                <div className="flex justify-end gap-1">
                  <IconButton label={t('builder.canvas.move_up')} disabled={i === 0} className="size-7" onClick={() => { const v = [...items]; [v[i - 1], v[i]] = [v[i]!, v[i - 1]!]; setItems(v); }}><ArrowUp className="size-3.5" /></IconButton>
                  <IconButton label={t('builder.remove')} className="size-7 text-danger" onClick={() => setItems(items.filter((_, k) => k !== i))}><Trash2 className="size-3.5" /></IconButton>
                </div>
                <LocalizedInput label={fl('question')} value={it.q} onChange={(v) => setItems(items.map((x, k) => (k === i ? { ...x, q: v } : x)), true)} />
                <LocalizedInput label={fl('answer')} multiline maxLength={2000} value={it.a} onChange={(v) => setItems(items.map((x, k) => (k === i ? { ...x, a: v } : x)), true)} />
              </div>
            ))}
            {items.length < 40 ? <Button size="sm" variant="outline" icon={<Plus className="size-4" />} onClick={() => setItems([...items, { q: { ar: '' }, a: { ar: '' } }])}>{t('builder.faq_add')}</Button> : null}
          </div>
        );
      }
    }
  };

  const childTypes = BLOCK_TYPES.filter((x) => BLOCKS[x].placement.includes('columns') && !BLOCKS[x].feature);
  const [childType, setChildType] = useState<string>('');

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <BlockIcon name={d.icon} className="size-5 text-luma-700" />
        <h2 className="font-semibold">{d.label[locale]}</h2>
      </div>
      {parent ? <Button size="sm" variant="ghost" onClick={() => onSelect(parent.id)}>{t('builder.back_to_parent')}</Button> : null}
      {myWarnings.length ? (
        <Alert tone="warn" title={t('builder.warnings.title')}>
          <ul className="list-disc ps-4">{myWarnings.map((w, i) => <li key={i}>{t(`builder.warnings.codes.${w.code}`, { kind: t(`builder.warnings.kinds.${w.kind}`) })}</li>)}</ul>
        </Alert>
      ) : null}
      {FIELD_SPECS[block.type].map(field)}
      {d.actions ? <ActionEditor key={block.id} action={block.action} refs={refs} pages={pages} pageBlocks={pageBlocks} pick={pick} onChange={(a) => onChange((b) => { const { action: _a, ...rest } = b; return a ? { ...rest, action: a } : rest; })} /> : null}

      {block.type === 'columns' ? (
        <fieldset className="flex flex-col gap-2 rounded-lg border border-line p-3">
          <legend className="px-1 text-sm font-medium">{t('builder.columns.children')}</legend>
          {(block.children ?? []).map((c, i) => (
            <div key={c.id} className="flex items-center gap-1 rounded-md bg-luma-50 px-2 py-1 text-sm">
              <BlockIcon name={BLOCKS[c.type].icon} className="size-4" />
              <button type="button" className="flex-1 truncate text-start hover:underline" onClick={() => onSelect(c.id)}>{BLOCKS[c.type].label[locale]}</button>
              <IconButton label={t('builder.canvas.move_up')} disabled={i === 0} className="size-7" onClick={() => onChange((b) => { const ch = [...(b.children ?? [])]; [ch[i - 1], ch[i]] = [ch[i]!, ch[i - 1]!]; return { ...b, children: ch }; })}><ArrowUp className="size-3.5" /></IconButton>
              <IconButton label={t('builder.remove')} className="size-7 text-danger" onClick={() => onChange((b) => ({ ...b, children: (b.children ?? []).filter((x) => x.id !== c.id) }))}><Trash2 className="size-3.5" /></IconButton>
            </div>
          ))}
          {(block.children?.length ?? 0) < Math.min(MAX_CHILDREN, (props.count ?? 2) * 2) ? (
            <div className="flex gap-1">
              <Select aria-label={t('builder.columns.add')} value={childType} onChange={(e) => setChildType(e.target.value)}>
                <option value="">{t('builder.choose')}</option>
                {childTypes.map((x) => <option key={x} value={x}>{BLOCKS[x].label[locale]}</option>)}
              </Select>
              <Button size="sm" variant="outline" disabled={!childType} icon={<Plus className="size-4" />} onClick={() => { const nb = makeBlock(childType as never); onChange((b) => ({ ...b, children: [...(b.children ?? []), nb] })); setChildType(''); }}>{t('builder.add')}</Button>
            </div>
          ) : <p className="text-xs text-ink-muted">{t('builder.columns.full')}</p>}
        </fieldset>
      ) : null}

      <fieldset className="flex flex-col gap-2 rounded-lg border border-line p-3">
        <legend className="px-1 text-sm font-medium">{t('builder.visibility.title')}</legend>
        <Switch label={t('builder.visibility.enabled')} checked={block.visibility.enabled} onChange={(v) => onChange((b) => ({ ...b, visibility: { ...b.visibility, enabled: v } }))} />
        <Checkbox label={t('builder.visibility.mobile')} checked={block.visibility.mobile !== false} onChange={(v) => onChange((b) => ({ ...b, visibility: { ...b.visibility, mobile: v } }))} />
        <Checkbox label={t('builder.visibility.desktop')} checked={block.visibility.desktop !== false} onChange={(v) => onChange((b) => ({ ...b, visibility: { ...b.visibility, desktop: v } }))} />
      </fieldset>
    </div>
  );
}


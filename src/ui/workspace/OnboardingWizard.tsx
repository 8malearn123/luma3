'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, Check, CircleAlert, Plus, Trash2 } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useI18n } from '@/i18n/client';
import { api } from '../api';
import { useApiQuery, useErrorMessage, useUnsavedChangesWarning } from '../hooks';
import { Button } from '../components/button';
import { Checkbox, Field, FormErrorSummary, Input, Select, Textarea } from '../components/form';
import { Alert, Badge, ErrorState, LoadingState } from '../components/feedback';
import { cx } from '../components/cx';
import { ImageUpload } from './ImageUpload';
import { AUDIENCES, BUSINESS_TYPES, CHARACTER_TRAITS, PRIORITIES, SPECIALTIES, type OnboardingAnswers } from '@/shared/onboarding';
import { FONTS } from '@/shared/builder/theme';
import { WEEKDAYS } from '@/shared/format';

type Ob = { answers: OnboardingAnswers; completed_steps: number[]; current_step: number; version: number; draft_generated_at: string | null; pending_palette: { palette: Record<string, string>; seeds: string[] } | null };
type Readiness = { ready: boolean; items: Array<{ key: string; ok: boolean; action_path: string }> };

function toggle<T>(arr: T[] | undefined, v: T, max = 99) {
  const a = arr ?? [];
  return a.includes(v) ? a.filter((x) => x !== v) : a.length >= max ? a : [...a, v];
}

export function OnboardingWizard({ slug }: { slug: string }) {
  const { t, locale } = useI18n();
  const msg = useErrorMessage();
  const qc = useQueryClient();
  const q = useApiQuery<Ob>(['onboarding', slug], `/api/v1/t/${slug}/onboarding`);
  const [step, setStep] = useState<number | null>(null);
  const [draft, setDraft] = useState<Record<string, any>>({});
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [savedNote, setSavedNote] = useState(false);
  const [palette, setPalette] = useState<Record<string, string> | null>(null);
  const [generated, setGenerated] = useState<{ services_created: number } | null>(null);
  useUnsavedChangesWarning(dirty);

  useEffect(() => {
    if (q.data && step === null) setStep(Math.min(q.data.current_step, 8));
  }, [q.data, step]);
  useEffect(() => {
    if (q.data && step && step <= 7) { setDraft({ ...((q.data.answers as any)[step] ?? {}) }); setDirty(false); }
  }, [q.data, step]);
  useEffect(() => { if (q.data?.pending_palette?.palette) setPalette(q.data.pending_palette.palette); }, [q.data?.pending_palette]);

  const readiness = useApiQuery<Readiness>(['readiness', slug], step === 8 ? `/api/v1/t/${slug}/onboarding/readiness` : null);

  if (q.isLoading || step === null) return <LoadingState rows={4} />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const ob = q.data!;
  const set = (patch: Record<string, any>) => { setDraft((d) => ({ ...d, ...patch })); setDirty(true); };

  async function save(goTo: number, skip = false) {
    setBusy(true); setErr(null);
    try {
      const answers = skip ? {} : clean(draft);
      await api(`/api/v1/t/${slug}/onboarding/steps/${step}`, { method: 'PUT', body: { version: ob.version, answers } });
      setDirty(false); setSavedNote(true); setTimeout(() => setSavedNote(false), 2500);
      await qc.invalidateQueries({ queryKey: ['onboarding', slug] });
      setStep(goTo);
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }

  async function suggest(fromLogo: boolean) {
    setErr(null);
    try {
      const body = fromLogo ? { logo_asset_id: (ob.answers[2] as any)?.logo_asset_id } : { seeds: draft.existing_colors ?? [], excluded: draft.excluded_colors ?? [] };
      const r = await api<{ palette: Record<string, string> | null }>(`/api/v1/t/${slug}/onboarding/palette`, { body });
      setPalette(r.palette);
    } catch (e) { setErr(e); }
  }

  async function generate() {
    setBusy(true); setErr(null);
    try {
      const r = await api<{ services_created: number }>(`/api/v1/t/${slug}/onboarding/generate`, { body: {} });
      setGenerated(r);
      readiness.refetch();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }

  const steps = [1, 2, 3, 4, 5, 6, 7];
  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-semibold text-luma-900">{t('onboarding.title')}</h1>
      <p className="mb-4 text-sm text-ink-muted">{t('onboarding.subtitle')}</p>
      <ol className="mb-6 flex gap-1 overflow-x-auto" aria-label={t('onboarding.title')}>
        {steps.map((s) => (
          <li key={s} className="flex-1">
            <button onClick={() => !dirty && setStep(s)} aria-current={step === s ? 'step' : undefined}
              className={cx('flex w-full min-w-10 flex-col items-center gap-1 rounded-lg p-1.5 text-xs', step === s ? 'bg-luma-700 text-white' : ob.completed_steps.includes(s) ? 'bg-luma-200 text-luma-900' : 'bg-white text-ink-muted')}>
              <span className="font-semibold">{ob.completed_steps.includes(s) && step !== s ? <Check className="size-3.5" /> : s}</span>
              <span className="hidden truncate sm:block">{t(`onboarding.steps.${s}.title`)}</span>
            </button>
          </li>
        ))}
      </ol>
      {savedNote ? <Alert tone="ok" className="mb-3">{t('onboarding.saved_resume')}</Alert> : null}
      <div className="rounded-2xl bg-white p-5 shadow-sm">
        {step <= 7 ? (
          <>
            <p className="text-xs font-medium text-luma-500">{t('onboarding.step_of', { n: step })}</p>
            <h2 className="text-lg font-semibold">{t(`onboarding.steps.${step}.title`)}</h2>
            <p className="mb-4 text-sm text-ink-muted">{t(`onboarding.steps.${step}.hint`)}</p>
            <FormErrorSummary message={err ? msg(err) : null} />
            <div className="mt-3 flex flex-col gap-4">
              {step === 1 && <>
                <Field label={t('onboarding.fields.business_name')} required>{(p) => <Input {...p} value={draft.name ?? ''} onChange={(e) => set({ name: e.target.value })} />}</Field>
                <Field label={t('onboarding.fields.business_type')}>{(p) => <Select {...p} value={draft.business_type ?? 'salon'} onChange={(e) => set({ business_type: e.target.value })}>{BUSINESS_TYPES.map((b) => <option key={b} value={b}>{t(`onboarding.types.${b}`)}</option>)}</Select>}</Field>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label={t('onboarding.fields.city')}>{(p) => <Input {...p} value={draft.city ?? ''} onChange={(e) => set({ city: e.target.value })} />}</Field>
                  <Field label={t('onboarding.fields.branch_name')}>{(p) => <Input {...p} value={draft.branch_name ?? ''} onChange={(e) => set({ branch_name: e.target.value })} />}</Field>
                </div>
                <p className="text-xs text-ink-muted" dir="ltr">/s/{draft.slug}</p>
              </>}
              {step === 2 && <>
                <Checkbox label={t('onboarding.fields.has_identity')} checked={!!draft.has_existing_identity} onChange={(v) => set({ has_existing_identity: v })} />
                <ImageUpload slug={slug} purpose="logo" label={t('onboarding.upload_logo')} value={draft.logo_asset_id} onChange={(id) => set({ logo_asset_id: id })} />
                <Field label={t('onboarding.fields.wordmark')}>{(p) => <Input {...p} value={draft.wordmark_text ?? ''} onChange={(e) => set({ wordmark_text: e.target.value })} />}</Field>
              </>}
              {step === 3 && <>
                <fieldset><legend className="mb-2 text-sm font-medium">{t('onboarding.fields.traits')} (≤3)</legend>
                  <div className="flex flex-wrap gap-2">{CHARACTER_TRAITS.map((tr) => (
                    <button key={tr} type="button" aria-pressed={(draft.traits ?? []).includes(tr)} onClick={() => set({ traits: toggle(draft.traits, tr, 3) })}
                      className={cx('rounded-full border px-3 py-1 text-sm', (draft.traits ?? []).includes(tr) ? 'border-luma-700 bg-luma-700 text-white' : 'border-line')}>{t(`onboarding.traits.${tr}`)}</button>
                  ))}</div>
                </fieldset>
                <fieldset><legend className="mb-2 text-sm font-medium">{t('onboarding.fields.reference_style')}</legend>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">{(['soft_minimal', 'classic_luxury', 'modern_bold', 'natural_warm'] as const).map((s) => (
                    <button key={s} type="button" aria-pressed={draft.reference_style === s} onClick={() => set({ reference_style: s })}
                      className={cx('rounded-xl border p-3 text-sm', draft.reference_style === s ? 'border-luma-700 ring-2 ring-luma-200' : 'border-line')}>{t(`onboarding.styles.${s}`)}</button>
                  ))}</div>
                </fieldset>
                <Field label={t('onboarding.fields.description')}>{(p) => <Textarea {...p} maxLength={600} value={draft.description ?? ''} onChange={(e) => set({ description: e.target.value })} />}</Field>
              </>}
              {step === 4 && <>
                <ColorList label={t('onboarding.fields.existing_colors')} value={draft.existing_colors ?? []} max={4} onChange={(v) => set({ existing_colors: v })} />
                <ColorList label={t('onboarding.fields.excluded_colors')} value={draft.excluded_colors ?? []} max={6} onChange={(v) => set({ excluded_colors: v })} />
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" size="sm" onClick={() => suggest(false)}>{t('onboarding.palette_suggested')}</Button>
                  {(ob.answers[2] as any)?.logo_asset_id ? <Button variant="outline" size="sm" onClick={() => suggest(true)}>{t('onboarding.from_logo')}</Button> : null}
                </div>
                {palette ? (
                  <div className="rounded-xl border border-line p-3">
                    <p className="mb-2 text-xs text-ink-muted">{t('onboarding.palette_suggested')}</p>
                    <div className="flex flex-wrap gap-2">{Object.entries(palette).map(([k, c]) => <div key={k} className="flex flex-col items-center gap-1"><span className="size-10 rounded-lg border border-line" style={{ background: c }} /><span className="font-mono text-[10px]" dir="ltr">{k}</span></div>)}</div>
                    <Button className="mt-3" size="sm" icon={<Check className="size-4" />} onClick={() => set({ accepted_palette: palette })}>{t('onboarding.accept_palette')}</Button>
                    {draft.accepted_palette ? <Badge tone="ok" className="ms-2">✓</Badge> : null}
                  </div>
                ) : null}
                <div className="grid gap-4 sm:grid-cols-2">
                  {(['heading', 'body'] as const).map((k) => (
                    <Field key={k} label={t(`onboarding.fields.${k}_font`)}>
                      {(p) => <Select {...p} value={draft.fonts?.[k] ?? ''} onChange={(e) => set({ fonts: { heading: draft.fonts?.heading ?? 'el_messiri', body: draft.fonts?.body ?? 'ibm_plex_arabic', [k]: e.target.value } })}>
                        <option value="">—</option>
                        {Object.entries(FONTS).map(([key, f]) => <option key={key} value={key}>{f.family}</option>)}
                      </Select>}
                    </Field>
                  ))}
                </div>
              </>}
              {step === 5 && <>
                <ChipSet label={t('onboarding.fields.specialties')} options={SPECIALTIES} prefix="onboarding.specialties" value={draft.specialties} onChange={(v) => set({ specialties: v })} />
                <ChipSet label={t('onboarding.fields.audience')} options={AUDIENCES} prefix="onboarding.audience" value={draft.audience} onChange={(v) => set({ audience: v })} />
                <fieldset className="flex flex-col gap-2"><legend className="mb-1 text-sm font-medium">{t('onboarding.fields.services')}</legend>
                  {(draft.services ?? []).map((s: any, i: number) => (
                    <div key={i} className="grid grid-cols-[1fr_6rem_6rem_auto] items-end gap-2">
                      <Field label={t('onboarding.fields.service_name')}>{(p) => <Input {...p} value={s.name} onChange={(e) => set({ services: draft.services.map((x: any, j: number) => j === i ? { ...x, name: e.target.value } : x) })} />}</Field>
                      <Field label={t('onboarding.fields.price_sar')}>{(p) => <Input {...p} dir="ltr" inputMode="decimal" value={s.price_sar ?? ''} onChange={(e) => set({ services: draft.services.map((x: any, j: number) => j === i ? { ...x, price_sar: e.target.value === '' ? undefined : Number(e.target.value) } : x) })} />}</Field>
                      <Field label={t('onboarding.fields.duration_min')}>{(p) => <Input {...p} dir="ltr" inputMode="numeric" value={s.duration_min ?? ''} onChange={(e) => set({ services: draft.services.map((x: any, j: number) => j === i ? { ...x, duration_min: e.target.value === '' ? undefined : Number(e.target.value) } : x) })} />}</Field>
                      <Button variant="ghost" size="sm" aria-label={t('onboarding.remove')} onClick={() => set({ services: draft.services.filter((_: any, j: number) => j !== i) })}><Trash2 className="size-4" /></Button>
                    </div>
                  ))}
                  <Button variant="outline" size="sm" className="self-start" icon={<Plus className="size-4" />} onClick={() => set({ services: [...(draft.services ?? []), { name: '' }] })}>{t('onboarding.add_service')}</Button>
                </fieldset>
              </>}
              {step === 6 && (
                <fieldset><legend className="mb-1 text-sm font-medium">{t('onboarding.fields.priorities')}</legend>
                  <p className="mb-2 text-xs text-ink-muted">{t('onboarding.drag_hint')}</p>
                  <ol className="flex flex-col gap-1.5">
                    {(draft.priorities?.length ? draft.priorities : [...PRIORITIES]).map((p: string, i: number, arr: string[]) => (
                      <li key={p} className="flex items-center gap-2 rounded-lg border border-line px-3 py-2">
                        <span className="w-5 text-xs text-ink-muted">{i + 1}</span><span className="flex-1 text-sm">{t(`onboarding.priorities.${p}`)}</span>
                        <button type="button" aria-label={t('actions.move_up')} disabled={i === 0} className="rounded p-1 hover:bg-luma-100 disabled:opacity-30" onClick={() => { const a = [...arr]; [a[i - 1], a[i]] = [a[i]!, a[i - 1]!]; set({ priorities: a }); }}><ArrowUp className="size-4" /></button>
                        <button type="button" aria-label={t('actions.move_down')} disabled={i === arr.length - 1} className="rounded p-1 hover:bg-luma-100 disabled:opacity-30" onClick={() => { const a = [...arr]; [a[i + 1], a[i]] = [a[i]!, a[i + 1]!]; set({ priorities: a }); }}><ArrowDown className="size-4" /></button>
                      </li>
                    ))}
                  </ol>
                </fieldset>
              )}
              {step === 7 && <>
                <ImageUpload slug={slug} purpose="cover" label={t('onboarding.upload_cover')} value={draft.cover_asset_id} onChange={(id) => set({ cover_asset_id: id })} />
                <Field label={t('onboarding.fields.tagline')}>{(p) => <Input {...p} maxLength={140} value={draft.tagline ?? ''} onChange={(e) => set({ tagline: e.target.value })} />}</Field>
                <Field label={t('onboarding.fields.intro')}>{(p) => <Textarea {...p} rows={4} maxLength={1500} value={draft.intro ?? ''} onChange={(e) => set({ intro: e.target.value })} />}</Field>
                <div className="grid gap-4 sm:grid-cols-3">
                  <Field label={t('fields.phone')}>{(p) => <Input {...p} dir="ltr" value={draft.phone ?? ''} onChange={(e) => set({ phone: e.target.value })} />}</Field>
                  <Field label={t('onboarding.fields.whatsapp')}>{(p) => <Input {...p} dir="ltr" value={draft.whatsapp ?? ''} onChange={(e) => set({ whatsapp: e.target.value })} />}</Field>
                  <Field label={t('fields.email')}>{(p) => <Input {...p} dir="ltr" type="email" value={draft.email ?? ''} onChange={(e) => set({ email: e.target.value })} />}</Field>
                </div>
                <Field label={t('onboarding.fields.address')}>{(p) => <Input {...p} value={draft.address ?? ''} onChange={(e) => set({ address: e.target.value })} />}</Field>
                <fieldset className="flex flex-col gap-2"><legend className="mb-1 text-sm font-medium">{t('onboarding.fields.hours')}</legend>
                  {(draft.hours ?? []).map((h: any, i: number) => (
                    <div key={i} className="flex flex-wrap items-center gap-2">
                      <Select aria-label={t('fields.date')} className="w-36" value={h.weekday} onChange={(e) => set({ hours: draft.hours.map((x: any, j: number) => j === i ? { ...x, weekday: Number(e.target.value) } : x) })}>{WEEKDAYS[locale].map((d, k) => <option key={k} value={k}>{d}</option>)}</Select>
                      <Input aria-label={t('fields.from')} type="time" className="w-32" value={h.opens} onChange={(e) => set({ hours: draft.hours.map((x: any, j: number) => j === i ? { ...x, opens: e.target.value } : x) })} />
                      <Input aria-label={t('fields.to')} type="time" className="w-32" value={h.closes} onChange={(e) => set({ hours: draft.hours.map((x: any, j: number) => j === i ? { ...x, closes: e.target.value } : x) })} />
                      <Button variant="ghost" size="sm" aria-label={t('onboarding.remove')} onClick={() => set({ hours: draft.hours.filter((_: any, j: number) => j !== i) })}><Trash2 className="size-4" /></Button>
                    </div>
                  ))}
                  <Button variant="outline" size="sm" className="self-start" icon={<Plus className="size-4" />} onClick={() => set({ hours: [...(draft.hours ?? []), { weekday: 0, opens: '10:00', closes: '22:00' }] })}>{t('onboarding.add_hours')}</Button>
                </fieldset>
                <div className="grid gap-4 sm:grid-cols-4">
                  {(['instagram', 'tiktok', 'snapchat', 'x'] as const).map((k) => (
                    <Field key={k} label={k}>{(p) => <Input {...p} dir="ltr" value={draft.social?.[k] ?? ''} onChange={(e) => set({ social: { ...(draft.social ?? {}), [k]: e.target.value } })} />}</Field>
                  ))}
                </div>
              </>}
            </div>
            <div className="mt-6 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-4">
              <Button variant="ghost" disabled={step === 1 || busy} onClick={() => setStep(step - 1)}>{t('actions.previous')}</Button>
              <div className="flex gap-2">
                {step > 1 ? <Button variant="outline" disabled={busy} onClick={() => save(step + 1, true)}>{t('actions.skip')}</Button> : null}
                <Button loading={busy} onClick={() => save(step + 1)}>{step === 7 ? t('onboarding.finish') : t('actions.next')}</Button>
              </div>
            </div>
          </>
        ) : (
          <div className="flex flex-col gap-4">
            <h2 className="text-lg font-semibold">{t('onboarding.generate')}</h2>
            <FormErrorSummary message={err ? msg(err) : null} />
            {generated ? <Alert tone="ok" title={t('onboarding.generated')}>{t('onboarding.generator_note')}</Alert> : null}
            <Button size="lg" className="self-start" loading={busy} onClick={generate}>{t('onboarding.generate')}</Button>
            <div>
              <h3 className="mb-2 font-semibold">{t('onboarding.readiness')}</h3>
              {readiness.data ? (
                <ul className="flex flex-col gap-1.5">
                  {readiness.data.items.map((i) => (
                    <li key={i.key} className="flex items-center gap-2 text-sm">
                      {i.ok ? <Check className="size-4 text-ok" aria-hidden /> : <CircleAlert className="size-4 text-warn" aria-hidden />}
                      <span className="sr-only">{i.ok ? '✓' : '✗'}</span>
                      {i.ok ? t(`onboarding.readiness_items.${i.key}`) : <Link className="underline" href={i.action_path}>{t(`onboarding.readiness_items.${i.key}`)}</Link>}
                    </li>
                  ))}
                </ul>
              ) : <LoadingState rows={2} />}
            </div>
            <div className="flex flex-wrap gap-2">
              <Link href={`/app/${slug}/builder`} className="rounded-lg bg-luma-700 px-4 py-2 text-sm font-medium text-white">{t('onboarding.open_builder')}</Link>
              <Link href={`/app/${slug}`} className="rounded-lg border border-luma-300 px-4 py-2 text-sm">{t('onboarding.go_overview')}</Link>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function clean(d: Record<string, any>) {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(d)) {
    if (v === '' || v === null || v === undefined) continue;
    if (k === 'services') { out[k] = (v as any[]).filter((s) => s.name?.trim()); continue; }
    if (k === 'social') { const s = Object.fromEntries(Object.entries(v).filter(([, x]) => x)); if (Object.keys(s).length) out[k] = s; continue; }
    out[k] = v;
  }
  return out;
}

function ChipSet({ label, options, prefix, value, onChange }: { label: string; options: readonly string[]; prefix: string; value?: string[]; onChange: (v: string[]) => void }) {
  const { t } = useI18n();
  return (
    <fieldset><legend className="mb-2 text-sm font-medium">{label}</legend>
      <div className="flex flex-wrap gap-2">{options.map((o) => (
        <button key={o} type="button" aria-pressed={(value ?? []).includes(o)} onClick={() => onChange(toggle(value, o))}
          className={cx('rounded-full border px-3 py-1 text-sm', (value ?? []).includes(o) ? 'border-luma-700 bg-luma-700 text-white' : 'border-line')}>{t(`${prefix}.${o}`)}</button>
      ))}</div>
    </fieldset>
  );
}

function ColorList({ label, value, onChange, max }: { label: string; value: string[]; onChange: (v: string[]) => void; max: number }) {
  const { t } = useI18n();
  return (
    <fieldset><legend className="mb-2 text-sm font-medium">{label}</legend>
      <div className="flex flex-wrap items-center gap-2">
        {value.map((c, i) => (
          <span key={i} className="flex items-center gap-1 rounded-full border border-line py-0.5 pe-1 ps-0.5">
            <input type="color" aria-label={`${label} ${i + 1}`} value={c} onChange={(e) => onChange(value.map((x, j) => (j === i ? e.target.value.toUpperCase() : x)))} className="size-7 cursor-pointer rounded-full border-0 bg-transparent" />
            <span className="font-mono text-xs" dir="ltr">{c}</span>
            <button type="button" aria-label={t('onboarding.remove')} onClick={() => onChange(value.filter((_, j) => j !== i))}><Trash2 className="size-3.5" /></button>
          </span>
        ))}
        {value.length < max ? <Button variant="outline" size="sm" icon={<Plus className="size-4" />} onClick={() => onChange([...value, '#B88F84'])}>{t('actions.add')}</Button> : null}
      </div>
    </fieldset>
  );
}

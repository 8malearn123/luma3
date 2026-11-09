'use client';

import { useState } from 'react';
import { Download } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { Input } from '../../components/form';

const iso = (d: Date) => d.toISOString().slice(0, 10);
export function lastDays(n: number) {
  const to = new Date();
  return { from: iso(new Date(to.getTime() - (n - 1) * 86_400_000)), to: iso(to) };
}

export type PeriodValue = { from: string; to: string };

/** Period picker: presets plus explicit from/to dates (Riyadh calendar days on the server). */
export function PeriodPicker({ value, onChange }: { value: PeriodValue; onChange: (v: PeriodValue) => void }) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(value);
  const presets: Array<[string, PeriodValue]> = [
    ['last7', lastDays(7)], ['last30', lastDays(30)], ['last90', lastDays(90)],
    ['this_year', { from: `${new Date().getUTCFullYear()}-01-01`, to: iso(new Date()) }],
  ];
  return (
    <div className="flex flex-wrap items-end gap-2" role="group" aria-label={t('admin.period.label')}>
      {presets.map(([k, v]) => (
        <button key={k} type="button" onClick={() => { setDraft(v); onChange(v); }}
          className={`rounded-full border px-3 py-1.5 text-xs ${value.from === v.from && value.to === v.to ? 'border-luma-700 bg-luma-700 text-white' : 'border-line hover:bg-luma-50'}`}>
          {t(`admin.period.${k}`)}
        </button>
      ))}
      <label className="flex items-center gap-1 text-xs text-ink-muted">{t('admin.period.from')}
        <Input type="date" className="w-36" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} /></label>
      <label className="flex items-center gap-1 text-xs text-ink-muted">{t('admin.period.to')}
        <Input type="date" className="w-36" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} /></label>
      <button type="button" className="rounded-lg bg-luma-100 px-3 py-2 text-xs font-medium text-luma-800 hover:bg-luma-200" onClick={() => draft.from && draft.to && onChange(draft)}>{t('admin.period.apply')}</button>
    </div>
  );
}

/** Same-origin GET download (cookies sent); the server audits every export. */
export function CsvLink({ href, label }: { href: string; label?: string }) {
  const { t } = useI18n();
  return (
    <a href={href} download className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-white px-3 py-1.5 text-sm hover:bg-luma-50">
      <Download className="size-4" aria-hidden />{label ?? t('admin.export_csv')}
    </a>
  );
}

export const pct = (rate: number | null | undefined) => (rate == null ? '—' : `${(rate * 100).toFixed(1)}%`);
export const bpPct = (bp: number | null | undefined) => (bp == null ? '—' : `${(bp / 100).toFixed(bp % 100 ? 1 : 0)}`);

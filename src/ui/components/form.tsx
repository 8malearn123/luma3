'use client';

import { forwardRef, useId, useState, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { AlertCircle } from 'lucide-react';
import { cx } from './cx';
import { useI18n } from '@/i18n/client';

const control = 'w-full rounded-lg border border-line bg-white px-3 text-sm text-ink placeholder:text-ink-muted/70 focus:border-luma-500 focus:outline-none focus:ring-2 focus:ring-luma-200 disabled:bg-luma-50 aria-[invalid=true]:border-danger';

export function Field({ label, hint, error, required, children, id: idProp, className }: { label: ReactNode; hint?: ReactNode; error?: string | null; required?: boolean; children: (props: { id: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean }) => ReactNode; id?: string; className?: string }) {
  const gen = useId();
  const id = idProp ?? gen;
  const { t } = useI18n();
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-err` : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className={cx('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className="text-sm font-medium text-ink">
        {label}{required ? <span className="text-danger" aria-hidden> *</span> : null}
        {required ? <span className="sr-only"> ({t('fields.required')})</span> : null}
      </label>
      {children({ id, 'aria-describedby': describedBy, 'aria-invalid': !!error || undefined })}
      {hint && !error ? <p id={`${id}-hint`} className="text-xs text-ink-muted">{hint}</p> : null}
      {error ? <p id={`${id}-err`} className="flex items-center gap-1 text-xs text-danger"><AlertCircle className="size-3.5" aria-hidden />{error}</p> : null}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...p }, ref) {
  return <input ref={ref} className={cx(control, 'h-10', className)} {...p} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, rows = 3, ...p }, ref) {
  return <textarea ref={ref} rows={rows} className={cx(control, 'py-2', className)} {...p} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, children, ...p }, ref) {
  return <select ref={ref} className={cx(control, 'h-10 pe-8', className)} {...p}>{children}</select>;
});

export function Checkbox({ label, checked, onChange, disabled, description }: { label: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; description?: ReactNode }) {
  const id = useId();
  return (
    <div className="flex items-start gap-2">
      <input id={id} type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 size-4 rounded border-line accent-luma-700" />
      <label htmlFor={id} className="text-sm">
        {label}
        {description ? <span className="block text-xs text-ink-muted">{description}</span> : null}
      </label>
    </div>
  );
}

export function Switch({ label, checked, onChange, disabled }: { label: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)} className="inline-flex items-center gap-2 text-sm disabled:opacity-50">
      <span className={cx('relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors', checked ? 'bg-luma-700' : 'bg-luma-200')}>
        <span className={cx('absolute top-0.5 size-4 rounded-full bg-white shadow transition-all', checked ? 'start-[18px]' : 'start-0.5')} />
      </span>
      {label}
    </button>
  );
}

/** Error summary at the top of a form, linking to each invalid field. */
export function FormErrorSummary({ message, issues }: { message?: string | null; issues?: Array<{ path: string; message: string }> }) {
  if (!message && !issues?.length) return null;
  return (
    <div role="alert" tabIndex={-1} className="rounded-lg border border-danger/30 bg-danger-bg p-3 text-sm text-danger">
      {message ? <p className="font-medium">{message}</p> : null}
      {issues?.length ? <ul className="mt-1 list-disc ps-5">{issues.map((i) => <li key={i.path}>{i.path ? `${i.path}: ` : ''}{i.message}</li>)}</ul> : null}
    </div>
  );
}

/** Arabic/English pair editor for business content. */
export function LocalizedInput({ label, value, onChange, multiline, maxLength = 160, required }: { label: ReactNode; value: { ar?: string; en?: string } | undefined; onChange: (v: { ar?: string; en?: string }) => void; multiline?: boolean; maxLength?: number; required?: boolean }) {
  const [tab, setTab] = useState<'ar' | 'en'>('ar');
  const id = useId();
  const v = value ?? {};
  const C = multiline ? Textarea : Input;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <label htmlFor={`${id}-${tab}`} className="text-sm font-medium">{label}{required ? <span className="text-danger"> *</span> : null}</label>
        <div role="tablist" className="flex rounded-md bg-luma-100 p-0.5 text-xs">
          {(['ar', 'en'] as const).map((l) => (
            <button key={l} role="tab" type="button" aria-selected={tab === l} onClick={() => setTab(l)} className={cx('rounded px-2 py-0.5', tab === l ? 'bg-white shadow-sm' : 'text-ink-muted')}>{l === 'ar' ? 'ع' : 'EN'}</button>
          ))}
        </div>
      </div>
      <C id={`${id}-${tab}`} dir={tab === 'ar' ? 'rtl' : 'ltr'} lang={tab} maxLength={maxLength} value={v[tab] ?? ''} onChange={(e: any) => onChange({ ...v, [tab]: e.target.value })} />
    </div>
  );
}

/** SAR amount editor that stores integer halalas. */
export function MoneyInput({ value, onChange, id, ...rest }: { value: number | null | undefined; onChange: (minor: number | null) => void; id?: string } & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  const [text, setText] = useState(value == null ? '' : String(value / 100));
  return (
    <div className="relative" dir="ltr">
      <Input id={id} inputMode="decimal" dir="ltr" value={text} {...rest}
        onChange={(e) => {
          const t = e.target.value.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/[^0-9.]/g, '');
          setText(t);
          onChange(t === '' ? null : Math.round(Number(t) * 100));
        }} className="pe-12" />
      <span className="pointer-events-none absolute inset-y-0 end-3 flex items-center text-xs text-ink-muted">SAR</span>
    </div>
  );
}

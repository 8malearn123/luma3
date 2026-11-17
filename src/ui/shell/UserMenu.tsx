'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Check, ChevronDown, Globe, LogOut, Monitor, Moon, Sun, User } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { api } from '../api';
import { cx } from '../components/cx';
import { applyThemePref, currentThemePref, type ThemePref } from './theme';

const THEMES: Array<{ value: ThemePref; Icon: typeof Sun }> = [
  { value: 'system', Icon: Monitor }, { value: 'light', Icon: Sun }, { value: 'dark', Icon: Moon },
];

export function UserMenu({ name }: { name: string }) {
  const { t, locale, setLocale } = useI18n();
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState<ThemePref>('system');
  const item = 'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-ink hover:bg-surface-muted';
  return (
    <div className="relative">
      <button type="button" onClick={() => { setTheme(currentThemePref()); setOpen((o) => !o); }} aria-expanded={open} aria-haspopup="menu"
        className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm hover:bg-accent-soft">
        <span className="flex size-7 items-center justify-center rounded-full bg-accent-soft text-heading"><User className="size-4" aria-hidden /></span>
        <span className="hidden max-w-32 truncate sm:inline">{name}</span><ChevronDown className="size-4" aria-hidden />
      </button>
      {open ? (
        <div role="menu" className="absolute end-0 z-40 mt-1 w-60 rounded-xl border border-line bg-surface p-1 shadow-lg" onMouseLeave={() => setOpen(false)}>
          <Link role="menuitem" href="/account" className={item}><User className="size-4" aria-hidden />{t('nav.account')}</Link>
          <button type="button" role="menuitem" onClick={() => setLocale(locale === 'ar' ? 'en' : 'ar')} className={item}><Globe className="size-4" aria-hidden />{t('locale.switch')}</button>
          {/* Appearance (DESIGN_GUIDE §11): saved in a cookie so the next page renders in the chosen theme. */}
          <div role="group" aria-label={t('theme.label')} className="my-1 border-y border-line py-1">
            <p className="px-3 pb-1 pt-1 text-xs text-ink-muted" aria-hidden>{t('theme.label')}</p>
            {THEMES.map(({ value, Icon }) => (
              <button key={value} type="button" role="menuitemradio" aria-checked={theme === value}
                onClick={() => { applyThemePref(value); setTheme(value); }} className={cx(item, theme === value && 'font-semibold')}>
                <Icon className="size-4" aria-hidden />
                <span className="flex-1 text-start">{t(`theme.${value}`)}</span>
                {theme === value ? <Check className="size-4 text-link" aria-hidden /> : null}
              </button>
            ))}
          </div>
          <button type="button" role="menuitem" onClick={async () => { await api('/api/v1/auth/logout', { body: {} }).catch(() => {}); window.location.href = '/'; }}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-danger hover:bg-danger-bg"><LogOut className="size-4" aria-hidden />{t('actions.sign_out')}</button>
        </div>
      ) : null}
    </div>
  );
}

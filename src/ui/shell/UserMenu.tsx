'use client';

import Link from 'next/link';
import { useState } from 'react';
import { ChevronDown, Globe, LogOut, User } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { api } from '../api';

export function UserMenu({ name }: { name: string }) {
  const { t, locale, setLocale } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="menu" className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm hover:bg-luma-100">
        <span className="flex size-7 items-center justify-center rounded-full bg-luma-200 text-luma-800"><User className="size-4" /></span>
        <span className="hidden max-w-32 truncate sm:inline">{name}</span><ChevronDown className="size-4" />
      </button>
      {open ? (
        <div role="menu" className="absolute end-0 mt-1 w-56 rounded-xl border border-line bg-white p-1 shadow-lg" onMouseLeave={() => setOpen(false)}>
          <Link role="menuitem" href="/account" className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-luma-50"><User className="size-4" />{t('nav.account')}</Link>
          <button role="menuitem" onClick={() => setLocale(locale === 'ar' ? 'en' : 'ar')} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-luma-50"><Globe className="size-4" />{t('locale.switch')}</button>
          <button role="menuitem" onClick={async () => { await api('/api/v1/auth/logout', { body: {} }).catch(() => {}); window.location.href = '/'; }} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-danger hover:bg-danger-bg"><LogOut className="size-4" />{t('actions.sign_out')}</button>
        </div>
      ) : null}
    </div>
  );
}

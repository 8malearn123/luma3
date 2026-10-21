'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { ExternalLink, Menu, X } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import type { ClientAccess } from '@/server/pages';
import { AccessProvider } from './access-context';
import { NavIcon } from './icons';
import { visibleNav } from './nav';
import { UserMenu } from './UserMenu';
import { NotificationsBell } from './NotificationsBell';
import { LumaMark } from '../components/brand';
import { cx } from '../components/cx';
import { Alert } from '../components/feedback';

export function DashboardShell({ access, user, children }: { access: ClientAccess; user: { displayName: string; isDemo: boolean }; children: ReactNode }) {
  const { t } = useI18n();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const items = visibleNav(access);
  const sections = ['operate', 'sell', 'grow', 'configure'] as const;
  const isActive = (href: string) => (href === `/app/${access.slug}` ? pathname === href : pathname.startsWith(href));

  const nav = (
    <nav aria-label={t('a11y.menu')} className="flex flex-col gap-4 p-3">
      {sections.map((s) => {
        const list = items.filter((i) => i.section === s);
        if (!list.length) return null;
        return (
          <div key={s}>
            <p className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-luma-500">{t(`nav.sections.${s}`)}</p>
            <ul className="flex flex-col gap-0.5">
              {list.map((i) => {
                const href = i.href(access.slug);
                return (
                  <li key={i.key}>
                    <Link href={href} onClick={() => setOpen(false)} aria-current={isActive(href) ? 'page' : undefined}
                      className={cx('flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm', isActive(href) ? 'bg-luma-700 text-white' : 'text-ink hover:bg-luma-100')}>
                      <NavIcon name={i.icon} className="size-4" />{t(`nav.${i.key}`)}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </nav>
  );

  return (
    <AccessProvider access={access}>
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:bg-white focus:p-2">{t('a11y.skip_to_content')}</a>
      <div className="flex min-h-dvh">
        <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 overflow-y-auto border-e border-line bg-white lg:block">
          <div className="flex items-center gap-2 border-b border-line px-4 py-3">
            <LumaMark className="h-8 w-auto" />
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">{access.name}</p>
              <p className="text-xs text-ink-muted">{t(`roles.${access.role}`)}</p>
            </div>
          </div>
          {nav}
        </aside>
        {open ? (
          <div className="fixed inset-0 z-40 lg:hidden">
            <div className="absolute inset-0 bg-ink/30" onClick={() => setOpen(false)} aria-hidden />
            <aside className="absolute inset-y-0 start-0 w-72 overflow-y-auto bg-white shadow-xl">
              <div className="flex items-center justify-between border-b border-line px-4 py-3">
                <p className="font-semibold">{access.name}</p>
                <button onClick={() => setOpen(false)} aria-label={t('a11y.close_menu')}><X className="size-5" /></button>
              </div>
              {nav}
            </aside>
          </div>
        ) : null}
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-30 flex items-center gap-2 border-b border-line bg-white/90 px-3 py-2 backdrop-blur sm:px-5">
            <button className="lg:hidden" onClick={() => setOpen(true)} aria-label={t('a11y.open_menu')}><Menu className="size-5" /></button>
            <Link href="/app" className="text-sm text-ink-muted hover:text-ink">{t('nav.switch_business')}</Link>
            <div className="flex-1" />
            {access.status === 'active' ? (
              <a href={`/s/${access.slug}`} target="_blank" rel="noreferrer" className="hidden items-center gap-1 text-sm text-luma-700 hover:underline sm:inline-flex">
                {t('nav.storefront')}<ExternalLink className="size-3.5" />
              </a>
            ) : null}
            <NotificationsBell />
            <UserMenu name={user.displayName} />
          </header>
          {user.isDemo ? <div className="bg-luma-700 px-4 py-1 text-center text-xs text-white">{t('demo.banner')}</div> : null}
          {access.support ? <Alert tone="warn" className="m-3">{t('support_banner')}</Alert> : null}
          {access.readOnly && !access.support ? <Alert tone="warn" className="m-3">{t('readonly_banner')}</Alert> : null}
          <main id="main" className="mx-auto w-full max-w-7xl flex-1 p-3 sm:p-6">{children}</main>
        </div>
      </div>
    </AccessProvider>
  );
}

'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { createContext, useContext, useState, type ReactNode } from 'react';
import {
  Building2, ChartLine, CreditCard, KeyRound, Layers, LayoutDashboard, LayoutTemplate, LifeBuoy, Menu, Plug, ScrollText, ShieldAlert, Sparkles, Users, X,
  type LucideIcon,
} from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { LumaLogo, LumaMark } from '../components/brand';
import { cx } from '../components/cx';
import { Alert } from '../components/feedback';
import { UserMenu } from '../shell/UserMenu';
import { NotificationsBell } from '../shell/NotificationsBell';
import { StepUpProvider } from './stepup';

export type PlatformNavItem = { key: string; href: string; icon: LucideIcon; cap: string | null };

/** LUMA administration navigation. Items are hidden without the capability; the server enforces regardless. */
export const PLATFORM_NAV: PlatformNavItem[] = [
  { key: 'overview', href: '/platform', icon: LayoutDashboard, cap: null },
  { key: 'tenants', href: '/platform/tenants', icon: Building2, cap: 'platform.tenants.view' },
  { key: 'subscriptions', href: '/platform/subscriptions', icon: CreditCard, cap: 'platform.tenants.view' },
  { key: 'plans', href: '/platform/plans', icon: Layers, cap: 'platform.tenants.view' },
  { key: 'reports', href: '/platform/reports', icon: ChartLine, cap: 'platform.revenue.view' },
  { key: 'users', href: '/platform/users', icon: Users, cap: 'platform.users.manage' },
  { key: 'support', href: '/platform/support', icon: LifeBuoy, cap: 'platform.support.access' },
  { key: 'policies', href: '/platform/policies', icon: ShieldAlert, cap: 'platform.policy.review' },
  { key: 'templates', href: '/platform/templates', icon: LayoutTemplate, cap: 'platform.templates.manage' },
  { key: 'audit', href: '/platform/audit', icon: ScrollText, cap: 'platform.audit.view' },
  { key: 'ai_usage', href: '/platform/ai-usage', icon: Sparkles, cap: 'platform.ai_usage.view' },
  { key: 'integrations', href: '/platform/integrations', icon: Plug, cap: 'platform.integrations.view' },
  { key: 'security', href: '/platform/security', icon: KeyRound, cap: null },
];

export type PlatformClient = { capabilities: string[]; roles: string[]; mfa: { enabled: boolean; verified: boolean } };
const Ctx = createContext<PlatformClient | null>(null);

export function usePlatform() {
  const c = useContext(Ctx);
  if (!c) throw new Error('usePlatform outside PlatformShell');
  return { ...c, can: (cap: string) => c.capabilities.includes(cap) };
}

export function PlatformShell({ platform, user, gate, children }: { platform: PlatformClient; user: { displayName: string; isDemo: boolean }; gate?: boolean; children: ReactNode }) {
  const { t } = useI18n();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const items = PLATFORM_NAV.filter((i) => !i.cap || platform.capabilities.includes(i.cap));
  const isActive = (href: string) => (href === '/platform' ? pathname === href : pathname.startsWith(href));

  const nav = (
    <nav aria-label={t('platform.nav.label')} className="flex flex-col gap-0.5 p-3">
      {items.map((i) => (
        <Link key={i.key} href={i.href} onClick={() => setOpen(false)} aria-current={isActive(i.href) ? 'page' : undefined}
          className={cx('flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm', isActive(i.href) ? 'bg-luma-700 text-white' : 'text-ink hover:bg-luma-100')}>
          <i.icon className="size-4" aria-hidden />{t(`platform.nav.${i.key}`)}
        </Link>
      ))}
    </nav>
  );

  return (
    <Ctx.Provider value={platform}>
      <StepUpProvider>
        <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:bg-white focus:p-2">{t('a11y.skip_to_content')}</a>
        <div className="flex min-h-dvh">
          {!gate ? (
            <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 overflow-y-auto border-e border-line bg-white lg:block">
              <div className="flex items-center gap-2 border-b border-line px-4 py-3">
                <LumaMark className="h-8 w-auto" />
                <div className="min-w-0">
                  <p className="truncate font-display text-sm font-semibold tracking-wide text-luma-800">LUMA</p>
                  <p className="text-xs text-ink-muted">{t('platform.title')}</p>
                </div>
              </div>
              {nav}
            </aside>
          ) : null}
          {open && !gate ? (
            <div className="fixed inset-0 z-40 lg:hidden">
              <div className="absolute inset-0 bg-ink/30" onClick={() => setOpen(false)} aria-hidden />
              <aside className="absolute inset-y-0 start-0 w-72 overflow-y-auto bg-white shadow-xl">
                <div className="flex items-center justify-between border-b border-line px-4 py-3">
                  <LumaLogo className="h-7 w-auto" />
                  <button onClick={() => setOpen(false)} aria-label={t('a11y.close_menu')}><X className="size-5" /></button>
                </div>
                {nav}
              </aside>
            </div>
          ) : null}
          <div className="flex min-w-0 flex-1 flex-col">
            <header className="sticky top-0 z-30 flex items-center gap-2 border-b border-line bg-white/90 px-3 py-2 backdrop-blur sm:px-5">
              {!gate ? <button className="lg:hidden" onClick={() => setOpen(true)} aria-label={t('a11y.open_menu')}><Menu className="size-5" /></button> : null}
              <span className="text-sm font-medium text-luma-800">{t('platform.title')}</span>
              <span className="hidden text-xs text-ink-muted sm:inline">· {platform.roles.map((r) => t(`platform.roles.${r}`)).join('، ')}</span>
              <div className="flex-1" />
              <Link href="/app" className="hidden text-sm text-ink-muted hover:text-ink sm:inline">{t('platform.to_businesses')}</Link>
              <NotificationsBell />
              <UserMenu name={user.displayName} />
            </header>
            {user.isDemo ? <div className="bg-luma-700 px-4 py-1 text-center text-xs text-white">{t('demo.banner')}</div> : null}
            {!gate && !platform.mfa.verified ? (
              <Alert tone="warn" className="m-3" title={t('platform.mfa_banner.title')}>
                <Link href="/platform/security" className="underline">{t('platform.mfa_banner.action')}</Link>
              </Alert>
            ) : null}
            <main id="main" className="mx-auto w-full max-w-7xl flex-1 p-3 sm:p-6">{children}</main>
          </div>
        </div>
      </StepUpProvider>
    </Ctx.Provider>
  );
}

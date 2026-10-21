'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { CalendarDays, Gavel, Lock, Receipt, ShieldCheck, Star, UserRound, type LucideIcon } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { cx } from '../components/cx';

const ITEMS: Array<{ key: string; href: string; Icon: LucideIcon }> = [
  { key: 'profile', href: '/account', Icon: UserRound },
  { key: 'bookings', href: '/account/bookings', Icon: CalendarDays },
  { key: 'orders', href: '/account/orders', Icon: Receipt },
  { key: 'reviews', href: '/account/reviews', Icon: Star },
  { key: 'privacy', href: '/account/privacy', Icon: ShieldCheck },
  { key: 'policy', href: '/account/policy', Icon: Gavel },
  { key: 'security', href: '/account/security', Icon: Lock },
];

export function AccountNav() {
  const { t } = useI18n();
  const pathname = usePathname();
  const active = (href: string) => (href === '/account' ? pathname === href : pathname.startsWith(href));
  return (
    <nav aria-label={t('account.title')} className="-mx-3 overflow-x-auto px-3 lg:mx-0 lg:px-0">
      <ul className="flex gap-1 lg:flex-col">
        {ITEMS.map(({ key, href, Icon }) => (
          <li key={key}>
            <Link href={href} aria-current={active(href) ? 'page' : undefined}
              className={cx('flex items-center gap-2 whitespace-nowrap rounded-lg px-3 py-2 text-sm', active(href) ? 'bg-luma-700 text-white' : 'text-ink hover:bg-luma-100')}>
              <Icon className="size-4" aria-hidden />{t(`account.nav.${key}`)}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

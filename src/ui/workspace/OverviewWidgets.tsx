'use client';

import Link from 'next/link';
import { useI18n } from '@/i18n/client';
import { useAccess } from '../shell/access-context';
import { visibleNav } from '../shell/nav';
import { NavIcon } from '../shell/icons';

/** Quick links to permitted sections. Domain widgets (today's bookings, low stock, …) plug in here. */
export function OverviewWidgets() {
  const { t } = useI18n();
  const access = useAccess();
  const items = visibleNav(access).filter((i) => i.key !== 'overview');
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {items.map((i) => (
        <Link key={i.key} href={i.href(access.slug)} className="flex items-center gap-3 rounded-xl border border-line bg-white p-4 hover:border-luma-300">
          <NavIcon name={i.icon} className="size-5 text-luma-500" />
          <span className="text-sm font-medium">{t(`nav.${i.key}`)}</span>
        </Link>
      ))}
    </div>
  );
}

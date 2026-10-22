import Link from 'next/link';
import { requireUser } from '@/server/pages';
import { getT } from '@/i18n/server';
import { LumaLogo } from '@/ui/components/brand';
import { AccountNav } from '@/ui/account/AccountNav';
import { UserMenu } from '@/ui/shell/UserMenu';
import { NotificationsBell } from '@/ui/shell/NotificationsBell';

export const metadata = { title: 'My account' };

/** Central customer account — LUMA identity surface (not a business storefront). */
export default async function AccountLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser('/account');
  const { t } = await getT();
  return (
    <div className="min-h-dvh bg-luma-50">
      <header className="border-b border-line bg-white">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-3 py-3 sm:px-6">
          <Link href="/" aria-label="LUMA"><LumaLogo className="h-9 w-auto" /></Link>
          <div className="flex-1" />
          <NotificationsBell />
          <UserMenu name={user.displayName} />
        </div>
      </header>
      <div className="mx-auto max-w-6xl px-3 py-6 sm:px-6">
        <div className="mb-5">
          <h1 className="font-display text-2xl text-luma-900">{t('account.title')}</h1>
          <p className="text-sm text-ink-muted">{t('account.subtitle')}</p>
        </div>
        <div className="flex flex-col gap-5 lg:flex-row">
          <aside className="lg:w-56 lg:shrink-0"><AccountNav /></aside>
          <main id="main" className="min-w-0 flex-1">{children}</main>
        </div>
      </div>
    </div>
  );
}

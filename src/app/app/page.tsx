import Link from 'next/link';
import { sql } from 'kysely';
import { Building2, Plus } from 'lucide-react';
import { db } from '@/server/db/client';
import { requireUser } from '@/server/pages';
import { getT } from '@/i18n/server';
import { LumaLogo } from '@/ui/components/brand';

export const metadata = { title: 'Businesses' };

/** Business selector. Lists only the caller's own active memberships; choosing one grants nothing extra. */
export default async function AppHome() {
  const user = await requireUser('/app');
  const { t } = await getT();
  const rows = (await sql<{ tenant_slug: string; tenant_name: string; role: string; tenant_status: string }>`
    select tenant_slug, tenant_name, role, tenant_status from app.memberships_for_user(${user.userId})`.execute(db())).rows;
  return (
    <div className="mx-auto flex min-h-dvh max-w-2xl flex-col gap-6 p-6">
      <LumaLogo className="h-12 w-auto self-start" />
      <div>
        <h1 className="text-2xl font-semibold text-luma-900">{t('selector.title')}</h1>
        <p className="text-sm text-ink-muted">{t('selector.note')}</p>
      </div>
      {rows.length ? (
        <ul className="flex flex-col gap-2">
          {rows.map((r) => (
            <li key={r.tenant_slug}>
              <Link href={r.role === 'specialist' ? '/staff' : `/app/${r.tenant_slug}`} className="flex items-center gap-3 rounded-xl border border-line bg-white p-4 hover:border-luma-300">
                <Building2 className="size-5 text-luma-500" aria-hidden />
                <div className="flex-1"><p className="font-medium">{r.tenant_name}</p><p className="text-xs text-ink-muted">{t(`roles.${r.role}`)} · /s/{r.tenant_slug}</p></div>
              </Link>
            </li>
          ))}
        </ul>
      ) : <p className="rounded-xl border border-dashed border-luma-200 bg-white p-6 text-center text-ink-muted">{t('selector.empty')}</p>}
      <Link href="/app/new" className="inline-flex items-center justify-center gap-2 self-start rounded-lg bg-luma-700 px-4 py-2 text-sm font-medium text-white hover:bg-luma-800"><Plus className="size-4" />{t('selector.create')}</Link>
      <Link href="/account" className="text-sm text-luma-700 underline">{t('nav.account')}</Link>
    </div>
  );
}

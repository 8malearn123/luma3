import Link from 'next/link';
import { requireTenantPage } from '@/server/pages';
import { getT } from '@/i18n/server';
import { readiness } from '@/server/domains/onboarding/service';
import { hasCapability } from '@/server/tenancy/access';
import { formatDate } from '@/shared/format';
import { withTenant } from '@/server/db/client';
import { OverviewWidgets } from '@/ui/workspace/OverviewWidgets';

export const metadata = { title: 'Overview' };

export default async function Overview({ params }: { params: Promise<{ tenantSlug: string }> }) {
  const { tenantSlug } = await params;
  const { access } = await requireTenantPage(tenantSlug);
  const { t, locale } = await getT();
  const canSetup = hasCapability(access, 'business.manage');
  const ready = canSetup ? await readiness(access) : null;
  const sub = await withTenant(access.tenantId, (trx) => trx.selectFrom('subscriptions').select(['status', 'trial_ends_at']).orderBy('created_at', 'desc').executeTakeFirst());
  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-2xl font-semibold text-luma-900">{access.name}</h1>
        {sub?.status === 'trialing' && sub.trial_ends_at ? <p className="text-sm text-ink-muted">{t('trial_banner', { date: formatDate(sub.trial_ends_at, { locale, tz: access.timezone }) })}</p> : null}
      </div>
      {ready && !ready.ready ? (
        <section className="rounded-2xl border border-warn/30 bg-warn-bg/50 p-4">
          <h2 className="font-semibold">{t('onboarding.not_ready')}</h2>
          <ul className="mt-2 flex flex-col gap-1 text-sm">
            {ready.items.filter((i) => !i.ok).map((i) => <li key={i.key}><Link className="underline" href={i.action_path}>{t(`onboarding.readiness_items.${i.key}`)}</Link></li>)}
          </ul>
          {access.status === 'onboarding' ? <Link href={`/app/${tenantSlug}/onboarding`} className="mt-3 inline-block rounded-lg bg-luma-700 px-4 py-2 text-sm text-white">{t('nav.onboarding')}</Link> : null}
        </section>
      ) : null}
      <OverviewWidgets />
    </div>
  );
}

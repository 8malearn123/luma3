'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useI18n } from '@/i18n/client';
import { useApiQuery } from '../hooks';
import { DeniedState, ErrorState, LoadingState } from '../components/feedback';
import { PageHeader, Tabs } from '../components/layout';
import { useAccess } from '../shell/access-context';
import { ProfileSection } from './Profile';
import { BookingPolicySection } from './Booking';
import { BranchesSection } from './Branches';
import { SubscriptionSection } from './Subscription';
import { DisplaySection, LegalTaxSection, NotificationsSection, PaymentsLink } from './Misc';
import { settingsKey, type SettingsData } from './shared';

export const SETTINGS_TABS = ['profile', 'branches', 'booking', 'payments', 'subscription', 'notifications', 'display', 'legal'] as const;
type Tab = (typeof SETTINGS_TABS)[number];

export function SettingsPage({ initialTab }: { initialTab?: string }) {
  const { t, timeFormat } = useI18n();
  const access = useAccess();
  const router = useRouter();
  const pathname = usePathname();
  const manage = access.can('business.manage');
  const visible = SETTINGS_TABS.filter((k) =>
    k === 'subscription' ? access.can('subscription.view', 'subscription.manage')
      : k === 'payments' ? access.can('payments.configure', 'business.manage')
        : k === 'branches' ? access.can('business.manage', 'schedule.manage')
          : manage);
  const tab: Tab | undefined = (visible as readonly string[]).includes(initialTab ?? '') ? (initialTab as Tab) : visible[0];
  const needsSettings = manage && tab && !['branches', 'subscription', 'payments'].includes(tab);
  const q = useApiQuery<SettingsData>(settingsKey(access.slug), needsSettings ? access.api('/settings') : null);

  if (!tab) return <DeniedState />;
  const go = (v: Tab) => router.replace(`${pathname}?tab=${v}`, { scroll: false });
  return (
    <div className="flex flex-col gap-1">
      <PageHeader title={t('biz_settings.title')} subtitle={t('biz_settings.subtitle')} />
      <Tabs value={tab} onChange={go} items={visible.map((v) => ({ value: v, label: t(`biz_settings.tabs.${v}`) }))} />
      {needsSettings && q.isLoading ? <LoadingState rows={4} /> : needsSettings && q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : (
        <div className="max-w-4xl">
          {tab === 'profile' && q.data ? <ProfileSection slug={access.slug} data={q.data} /> : null}
          {tab === 'branches' ? <BranchesSection slug={access.slug} canManage={manage && !access.readOnly} /> : null}
          {tab === 'booking' && q.data ? <BookingPolicySection slug={access.slug} data={q.data} timeFormat={timeFormat} /> : null}
          {tab === 'payments' ? <PaymentsLink slug={access.slug} /> : null}
          {tab === 'subscription' ? <SubscriptionSection slug={access.slug} canManage={access.can('subscription.manage')} tz={access.timezone} /> : null}
          {tab === 'notifications' && q.data ? <NotificationsSection slug={access.slug} data={q.data} /> : null}
          {tab === 'display' && q.data ? <DisplaySection slug={access.slug} data={q.data} /> : null}
          {tab === 'legal' && q.data ? <LegalTaxSection slug={access.slug} data={q.data} /> : null}
        </div>
      )}
    </div>
  );
}

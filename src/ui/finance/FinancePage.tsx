'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useI18n } from '@/i18n/client';
import { PageHeader, Tabs } from '../components/layout';
import { useAccess } from '../shell/access-context';
import { StepUpProvider } from '../policy/StepUp';
import { OverviewTab } from './OverviewTab';
import { ExpensesTab } from './ExpensesTab';
import { CommissionsTab } from './CommissionsTab';
import { DocumentsTab, RefundsTab } from './DocumentsTab';
import { ExportsTab } from './ExportsTab';

const TABS = ['overview', 'expenses', 'commissions', 'documents', 'refunds', 'exports'] as const;
type Tab = (typeof TABS)[number];

export function FinancePage({ demo }: { demo: boolean }) {
  const { t } = useI18n();
  const access = useAccess();
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const visible = TABS.filter((k) => k !== 'refunds' || access.can('refunds.request', 'refunds.approve', 'finance.view'));
  const raw = sp.get('tab') as Tab | null;
  const tab: Tab = raw && visible.includes(raw) ? raw : 'overview';
  const setTab = (v: Tab) => {
    const u = new URLSearchParams(sp.toString());
    if (v === 'overview') u.delete('tab'); else u.set('tab', v);
    router.replace(`${pathname}${u.toString() ? `?${u}` : ''}`, { scroll: false });
  };
  const label = (k: Tab) => (k === 'overview' ? t('finance.tabs.report') : t(`finance.tabs.${k}`));
  return (
    <StepUpProvider>
      <div>
        <PageHeader title={t('finance.title')} subtitle={t('fe.finance.subtitle', { tz: access.timezone })} />
        <Tabs value={tab} onChange={setTab} items={visible.map((k) => ({ value: k, label: label(k) }))} />
        {tab === 'overview' ? <OverviewTab /> : null}
        {tab === 'expenses' ? <ExpensesTab /> : null}
        {tab === 'commissions' ? <CommissionsTab demo={demo} /> : null}
        {tab === 'documents' ? <DocumentsTab /> : null}
        {tab === 'refunds' ? <RefundsTab /> : null}
        {tab === 'exports' ? <ExportsTab /> : null}
      </div>
    </StepUpProvider>
  );
}

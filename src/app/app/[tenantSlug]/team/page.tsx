import { Suspense } from 'react';
import { requireTenantPage } from '@/server/pages';
import { hasCapability } from '@/server/tenancy/access';
import { DeniedState, LoadingState } from '@/ui/components/feedback';
import { TeamPage } from '@/ui/team/TeamPage';

export const metadata = { title: 'Team' };

/** Team & HR (tabs via ?tab=: staff, schedule, leave, attendance, members; profile via ?staff=<id|new>). */
export default async function Page({ params }: { params: Promise<{ tenantSlug: string }> }) {
  const { tenantSlug } = await params;
  const { access } = await requireTenantPage(tenantSlug);
  if (!hasCapability(access, ['staff.edit', 'schedule.manage', 'team.manage', 'leave.approve', 'attendance.manage', 'schedule.view_own', 'leave.request', 'attendance.own'])) return <DeniedState />;
  return <Suspense fallback={<LoadingState rows={5} />}><TeamPage /></Suspense>;
}

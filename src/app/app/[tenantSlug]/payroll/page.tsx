import { Suspense } from 'react';
import { requireTenantPage } from '@/server/pages';
import { hasCapability } from '@/server/tenancy/access';
import { DeniedState, LoadingState } from '@/ui/components/feedback';
import { PayrollPage } from '@/ui/payroll/PayrollPage';

export const metadata = { title: 'Payroll' };

export default async function Page({ params }: { params: Promise<{ tenantSlug: string }> }) {
  const { tenantSlug } = await params;
  const { access } = await requireTenantPage(tenantSlug);
  if (!hasCapability(access, ['payroll.view'])) return <DeniedState />;
  return <Suspense fallback={<LoadingState rows={5} />}><PayrollPage /></Suspense>;
}

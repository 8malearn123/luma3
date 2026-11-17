import { Suspense } from 'react';
import { requireTenantPage } from '@/server/pages';
import { areaAvailable } from '@/server/tenancy/workspace-mode';
import { NotAvailable } from '@/ui/expert/NotAvailable';
import { hasCapability } from '@/server/tenancy/access';
import { DeniedState, LoadingState } from '@/ui/components/feedback';
import { PayrollPage } from '@/ui/payroll/PayrollPage';

export const metadata = { title: 'Payroll' };

export default async function Page({ params }: { params: Promise<{ tenantSlug: string }> }) {
  const { tenantSlug } = await params;
  const { access } = await requireTenantPage(tenantSlug);
  // Hidden for this business type (workspace-mode.ts): a direct URL shows «غير متاح», the API refuses too.
  if (!areaAvailable(access, 'payroll')) return <NotAvailable area="payroll" />;
  if (!hasCapability(access, ['payroll.view'])) return <DeniedState />;
  return <Suspense fallback={<LoadingState rows={5} />}><PayrollPage /></Suspense>;
}

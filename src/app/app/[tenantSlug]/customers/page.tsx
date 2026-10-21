import { requireTenantPage } from '@/server/pages';
import { hasCapability } from '@/server/tenancy/access';
import { DeniedState } from '@/ui/components/feedback';
import { CustomersPage } from '@/ui/customers/CustomersPage';

export const metadata = { title: 'Customers' };

export default async function Page({ params }: { params: Promise<{ tenantSlug: string }> }) {
  const { tenantSlug } = await params;
  const { access } = await requireTenantPage(tenantSlug);
  if (!hasCapability(access, 'customers.view')) return <DeniedState />;
  return <CustomersPage />;
}

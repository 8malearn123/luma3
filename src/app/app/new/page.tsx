import { requireUser } from '@/server/pages';
import { CreateBusinessForm } from '@/ui/workspace/CreateBusinessForm';
import { db } from '@/server/db/client';

export const metadata = { title: 'New business' };

export default async function NewBusiness({ searchParams }: { searchParams: Promise<{ plan?: string }> }) {
  const user = await requireUser('/app/new');
  const { plan } = await searchParams;
  const plans = await db().selectFrom('plans').select(['code', 'name_ar', 'name_en', 'trial_days']).where('status', '=', 'active').orderBy('sort').execute();
  return <CreateBusinessForm verified={user.emailVerified || user.phoneVerified} plans={plans} initialPlan={plan} />;
}

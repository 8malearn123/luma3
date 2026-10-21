import { redirect } from 'next/navigation';
import { sql } from 'kysely';
import { db } from '@/server/db/client';
import { requireUser } from '@/server/pages';

/** /onboarding → resume the owner's business that is still being set up, or create one. */
export default async function OnboardingEntry() {
  const user = await requireUser('/onboarding');
  const r = await sql<{ tenant_slug: string }>`select tenant_slug from app.memberships_for_user(${user.userId}) where role = 'owner' and tenant_status = 'onboarding' limit 1`.execute(db());
  redirect(r.rows[0] ? `/app/${r.rows[0].tenant_slug}/onboarding` : '/app/new');
}

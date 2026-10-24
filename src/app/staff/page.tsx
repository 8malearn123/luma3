import { redirect } from 'next/navigation';
import { sql } from 'kysely';
import { db } from '@/server/db/client';
import { requireUser } from '@/server/pages';

/** Staff entry point (used by sign-in and staff notifications): opens the caller's staff portal. */
export default async function StaffHome() {
  const user = await requireUser('/staff');
  const rows = (await sql<{ tenant_slug: string }>`
    select tenant_slug from app.memberships_for_user(${user.userId}) where role = 'specialist'`.execute(db())).rows;
  redirect(rows.length === 1 ? `/app/${rows[0]!.tenant_slug}/me` : '/app');
}

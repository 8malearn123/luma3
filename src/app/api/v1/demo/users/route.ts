import { sql } from 'kysely';
import { db } from '@/server/db/client';
import { env } from '@/server/env';
import { route } from '@/server/http/route';
import { Errors } from '@/server/http/errors';

/** PRIVATE DEMO ONLY — 404 in production or when DEMO_MODE is off. */
export const GET = route({
  auth: 'public',
  handler: async () => {
    if (!env().demoEnabled) throw Errors.notFound();
    const rows = await sql<{ id: string; display_name: string; role: string | null }>`
      select u.id, u.display_name,
        coalesce((select pr.role from platform_roles pr where pr.user_id = u.id and pr.revoked_at is null limit 1),
                 (select m.role from app.memberships_for_user(u.id) m limit 1), 'customer') as role
      from users u where u.is_demo and u.status = 'active' order by u.created_at`.execute(db());
    return { data: rows.rows.map((r) => ({ key: r.id, label: r.display_name, role: r.role })) };
  },
});

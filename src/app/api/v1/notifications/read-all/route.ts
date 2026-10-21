import { sql } from 'kysely';
import { db } from '@/server/db/client';
import { route } from '@/server/http/route';

export const POST = route({
  auth: 'user',
  handler: async ({ user }) => {
    const r = await sql<{ n: number }>`select app.mark_notifications_read(${user.userId}, null) as n`.execute(db());
    return { data: { marked: r.rows[0]?.n ?? 0 } };
  },
});

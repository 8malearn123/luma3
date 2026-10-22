import { sql } from 'kysely';
import { db } from '@/server/db/client';
import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';

export const POST = route({
  auth: 'user',
  handler: async ({ user, params }) => {
    const id = requireUuidParam(params, 'id');
    await sql`select app.mark_notifications_read(${user.userId}, ${[id]}::uuid[])`.execute(db());
    return { data: { read: true } };
  },
});

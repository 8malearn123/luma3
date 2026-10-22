import { sql } from 'kysely';
import { z } from 'zod';
import { db } from '@/server/db/client';
import { route } from '@/server/http/route';

/** GET /api/v1/notifications?before=ISO — the signed-in user's notifications (paginated by time). */
export const GET = route({
  auth: 'user',
  input: z.object({ before: z.string().datetime({ offset: true }).optional(), limit: z.coerce.number().int().min(1).max(50).default(20) }),
  handler: async ({ user, input }) => {
    const items = await sql<{ id: string; created_at: Date }>`select id, tenant_id, kind, title_ar, title_en, body_ar, body_en, target_path, read_at, created_at
      from app.notifications_for_user(${user.userId}, ${input.before ?? null}, ${input.limit})`.execute(db());
    const unread = await sql<{ n: number }>`select app.unread_notifications(${user.userId}) as n`.execute(db());
    const last = items.rows[items.rows.length - 1];
    return { data: { items: items.rows, unread: unread.rows[0]?.n ?? 0 }, meta: { next_before: items.rows.length === input.limit && last ? last.created_at : null } };
  },
});

import { sql } from 'kysely';
import type { z } from 'zod';
import { withSystem, withTenant } from '../../db/client';
import { Errors } from '../../http/errors';
import { audit, type AuditActor } from '../../infra/audit';
import { notifyUsers } from '../../infra/notify';
import { enqueue } from '../../infra/outbox';
import type { TenantAccess } from '../../tenancy/access';
import type { reviewRequestSettingsInput } from '@/shared/schemas/customer-experience';

/**
 * Review request after the visit («طلب التقييم بعد الزيارة»).
 *
 * The owner chooses the timing (tenant_settings.review_request_mode):
 *   off            — never asked;
 *   immediately    — on the next job run after the visit is completed;
 *   after_hours    — `review_request_delay_hours` after completion;
 * plus an optional single reminder `review_reminder_hours` after the first
 * request, only while no review was written.
 *
 * The periodic job sends an in-app notification linking to /account/reviews and
 * enqueues an outbox message (`review.request` / `review.reminder`) that the
 * messaging adapter delivers on the business's enabled channels when a provider
 * is connected (simulated in development). `review_requests` (unique per
 * booking) makes the request and the reminder exactly-once. Visits completed
 * more than 30 days ago are never asked.
 */
const MAX_AGE_DAYS = 30;

export async function getReviewRequestSettings(access: TenantAccess) {
  return withTenant(access.tenantId, (trx) => trx.selectFrom('tenant_settings')
    .select(['review_request_mode', 'review_request_delay_hours', 'review_reminder_hours', 'version']).where('tenant_id', '=', access.tenantId).executeTakeFirstOrThrow());
}

export async function updateReviewRequestSettings(access: TenantAccess, actor: AuditActor, input: z.infer<typeof reviewRequestSettingsInput>) {
  return withTenant(access.tenantId, async (trx) => {
    const r = await trx.updateTable('tenant_settings').set({
      review_request_mode: input.review_request_mode, review_request_delay_hours: input.review_request_delay_hours,
      review_reminder_hours: input.review_reminder_hours, version: sql`version + 1`,
    }).where('tenant_id', '=', access.tenantId).where('version', '=', input.version).returning('version').executeTakeFirst();
    if (!r) {
      const cur = await trx.selectFrom('tenant_settings').select('version').where('tenant_id', '=', access.tenantId).executeTakeFirstOrThrow();
      throw Errors.versionConflict(cur.version);
    }
    await audit(trx, actor, 'settings.review_requests_updated', { tenantId: access.tenantId, targetType: 'tenant_settings', targetId: access.tenantId, data: { ...input, version: undefined } });
    return { version: r.version };
  });
}

type Due = { id: string; tenant_id: string; customer_user_id: string; completed_at: Date; tenant_name: string };

async function announce(tenantId: string, d: { bookingId: string; userId: string; tenantName: string; reminder: boolean }) {
  return withTenant(tenantId, async (trx) => {
    const topic = d.reminder ? 'review.reminder' : 'review.request';
    await notifyUsers(trx, tenantId, [d.userId], {
      kind: topic,
      title_ar: d.reminder ? `تذكير: شاركينا رأيكِ في زيارتكِ لـ ${d.tenantName}` : `كيف كانت زيارتكِ لـ ${d.tenantName}؟`,
      title_en: d.reminder ? `Reminder: tell us about your visit to ${d.tenantName}` : `How was your visit to ${d.tenantName}?`,
      body_ar: 'تقييمكِ يساعدنا ويساعد غيركِ في الاختيار. يستغرق أقل من دقيقة.',
      body_en: 'Your review helps us and helps others choose. It takes less than a minute.',
      target_path: '/account/reviews', dedupe_key: `${topic}:${d.bookingId}`,
    });
    await enqueue(trx, topic, { booking_id: d.bookingId }, { tenantId, dedupeKey: `${topic}:${d.bookingId}` });
  });
}

/** One job run: first requests that are due, then reminders that are due. Idempotent. */
export async function sendReviewRequests(now = new Date()) {
  const due = await withSystem('find completed visits due a review request', (trx) => sql<Due>`
    select b.id, b.tenant_id, b.customer_user_id, e.completed_at, t.name as tenant_name
    from bookings b
    join tenants t on t.id = b.tenant_id
    join tenant_settings s on s.tenant_id = b.tenant_id
    join lateral (select max(created_at) as completed_at from booking_events ev where ev.booking_id = b.id and ev.to_status = 'completed') e on true
    where b.status = 'completed' and b.customer_user_id is not null and s.review_request_mode <> 'off'
      and e.completed_at is not null
      and e.completed_at > ${now}::timestamptz - make_interval(days => ${MAX_AGE_DAYS})
      and e.completed_at + (case when s.review_request_mode = 'immediately' then interval '0 hours' else make_interval(hours => s.review_request_delay_hours) end) <= ${now}::timestamptz
      and not exists (select 1 from review_requests r where r.booking_id = b.id)
      and not exists (select 1 from reviews v where v.booking_id = b.id)
    order by e.completed_at
    limit 500`.execute(trx));
  let sent = 0;
  for (const d of due.rows) {
    const inserted = await withTenant(d.tenant_id, (trx) => trx.insertInto('review_requests').values({
      tenant_id: d.tenant_id, booking_id: d.id, customer_user_id: d.customer_user_id, completed_at: d.completed_at, first_sent_at: now,
    }).onConflict((oc) => oc.columns(['tenant_id', 'booking_id']).doNothing()).returning('id').executeTakeFirst());
    if (!inserted) continue;
    await announce(d.tenant_id, { bookingId: d.id, userId: d.customer_user_id, tenantName: d.tenant_name, reminder: false });
    sent++;
  }

  const reminders = await withSystem('find review requests due a reminder', (trx) => sql<{ id: string; tenant_id: string; booking_id: string; customer_user_id: string; tenant_name: string }>`
    select r.id, r.tenant_id, r.booking_id, r.customer_user_id, t.name as tenant_name
    from review_requests r
    join tenants t on t.id = r.tenant_id
    join tenant_settings s on s.tenant_id = r.tenant_id
    where r.status = 'sent' and r.reminder_sent_at is null and s.review_request_mode <> 'off' and s.review_reminder_hours is not null
      and r.first_sent_at + make_interval(hours => s.review_reminder_hours) <= ${now}::timestamptz
      and r.completed_at > ${now}::timestamptz - make_interval(days => ${MAX_AGE_DAYS})
      and not exists (select 1 from reviews v where v.booking_id = r.booking_id)
    limit 500`.execute(trx));
  let reminded = 0;
  for (const r of reminders.rows) {
    const upd = await withTenant(r.tenant_id, (trx) => trx.updateTable('review_requests').set({ reminder_sent_at: now, status: 'reminded' })
      .where('id', '=', r.id).where('reminder_sent_at', 'is', null).returning('id').executeTakeFirst());
    if (!upd) continue;
    await announce(r.tenant_id, { bookingId: r.booking_id, userId: r.customer_user_id, tenantName: r.tenant_name, reminder: true });
    reminded++;
  }

  // Requests answered by a review are closed (no reminder is ever sent after a review).
  await withSystem('close answered review requests', (trx) => sql`
    update review_requests r set status = 'reviewed' where r.status <> 'reviewed' and exists (select 1 from reviews v where v.booking_id = r.booking_id)`.execute(trx));
  return { sent, reminded };
}

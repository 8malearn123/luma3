import { withTenant } from '../../db/client';
import { env } from '../../env';
import { sendTransactional, type Channel } from '../../infra/messaging';
import { registerOutbox, registerPeriodic } from '../../jobs/registry';
import { sendReviewRequests } from './requests';

/** Review requests after the visit: every 5 minutes (timing per business, see requests.ts). */
registerPeriodic({ name: 'reviews.request-after-visit', everySec: 300, run: async () => { await sendReviewRequests(); } });

/**
 * Messaging channel for the request/reminder (in addition to the in-app
 * notification). Delivered only on channels the business enabled; with no
 * provider connected the delivery is recorded as simulated (dev) or failed.
 */
async function deliver(ev: { id: string; tenantId: string | null; topic: string; payload: Record<string, unknown> }) {
  if (!ev.tenantId) return;
  const data = await withTenant(ev.tenantId, async (trx) => {
    const b = await trx.selectFrom('bookings as b').innerJoin('tenant_customers as c', 'c.id', 'b.tenant_customer_id')
      .select(['c.phone', 'c.email', 'c.display_name']).where('b.id', '=', String(ev.payload.booking_id)).executeTakeFirst();
    const t = await trx.selectFrom('tenants').select('name').where('id', '=', ev.tenantId!).executeTakeFirstOrThrow();
    const s = await trx.selectFrom('tenant_settings').select('notify_channels').where('tenant_id', '=', ev.tenantId!).executeTakeFirstOrThrow();
    const reviewed = await trx.selectFrom('reviews').select('id').where('booking_id', '=', String(ev.payload.booking_id)).executeTakeFirst();
    return b && !reviewed ? { b, tenant: t.name, channels: s.notify_channels } : null;
  });
  if (!data) return;
  const link = `${env().APP_URL}/account/reviews`;
  const body = ev.topic === 'review.reminder'
    ? `تذكير من ${data.tenant}: يسعدنا تقييمكِ لزيارتكِ الأخيرة ${link}`
    : `شكراً لزيارتكِ ${data.tenant}! كيف كانت تجربتكِ؟ قيّمي زيارتكِ: ${link}`;
  const targets: Array<{ channel: Channel; to: string | null }> = [
    { channel: 'whatsapp', to: data.b.phone }, { channel: 'sms', to: data.b.phone }, { channel: 'email', to: data.b.email },
  ];
  for (const t of targets) {
    if (!t.to || !data.channels.includes(t.channel)) continue;
    await sendTransactional({ channel: t.channel, to: t.to, subject: data.tenant, body, templateKey: ev.topic, locale: 'ar', tenantId: ev.tenantId, dedupeKey: `${ev.id}:${t.channel}` });
  }
}

registerOutbox('review.request', deliver);
registerOutbox('review.reminder', deliver);

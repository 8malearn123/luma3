import { DateTime } from 'luxon';
import { sql } from 'kysely';
import { withSystem, withTenant } from '../../db/client';
import { enqueue } from '../../infra/outbox';
import { sendTransactional, type Channel } from '../../infra/messaging';
import { registerOutbox, registerPeriodic } from '../../jobs/registry';

const TEMPLATES: Record<string, { ar: (b: Ctx) => string; en: (b: Ctx) => string }> = {
  'booking.confirmed': { ar: (b) => `تم تأكيد موعدك في ${b.tenant} يوم ${b.whenAr}. رقم الحجز ${b.number}.`, en: (b) => `Your appointment at ${b.tenant} on ${b.whenEn} is confirmed. Ref ${b.number}.` },
  'booking.cancelled': { ar: (b) => `تم إلغاء موعدك في ${b.tenant} (${b.number}).`, en: (b) => `Your appointment at ${b.tenant} (${b.number}) was cancelled.` },
  'booking.rescheduled': { ar: (b) => `تم تغيير موعدك في ${b.tenant} إلى ${b.whenAr}.`, en: (b) => `Your appointment at ${b.tenant} moved to ${b.whenEn}.` },
  'booking.reminder': { ar: (b) => `تذكير: موعدك في ${b.tenant} ${b.whenAr}.`, en: (b) => `Reminder: your appointment at ${b.tenant} is ${b.whenEn}.` },
};
type Ctx = { tenant: string; number: string; whenAr: string; whenEn: string };

/**
 * Transactional messages for booking events via the outbox (at-least-once,
 * deduplicated per event + channel). With no provider connected, deliveries are
 * recorded honestly as simulated (dev) or failed/no_provider — never as sent.
 */
async function deliverBookingMessage(ev: { id: string; tenantId: string | null; topic: string; payload: Record<string, unknown> }) {
  if (!ev.tenantId) return;
  const tpl = TEMPLATES[ev.topic];
  if (!tpl) return;
  const data = await withTenant(ev.tenantId, async (trx) => {
    const b = await trx.selectFrom('bookings as b').innerJoin('tenant_customers as c', 'c.id', 'b.tenant_customer_id')
      .select(['b.number', 'b.starts_at', 'b.timezone', 'b.status', 'c.phone', 'c.email']).where('b.id', '=', String(ev.payload.booking_id)).executeTakeFirst();
    const t = await trx.selectFrom('tenants').select('name').where('id', '=', ev.tenantId!).executeTakeFirstOrThrow();
    const s = await trx.selectFrom('tenant_settings').select('notify_channels').where('tenant_id', '=', ev.tenantId!).executeTakeFirstOrThrow();
    return b ? { b, tenant: t.name, channels: s.notify_channels } : null;
  });
  if (!data) return;
  if (ev.topic === 'booking.reminder' && data.b.status !== 'confirmed') return;
  const when = DateTime.fromJSDate(data.b.starts_at, { zone: data.b.timezone });
  const ctx: Ctx = { tenant: data.tenant, number: data.b.number, whenAr: when.setLocale('ar').toFormat('cccc d LLLL h:mm a'), whenEn: when.setLocale('en').toFormat('cccc d LLLL h:mm a') };
  const targets: Array<{ channel: Channel; to: string | null }> = [
    { channel: 'sms', to: data.b.phone }, { channel: 'whatsapp', to: data.b.phone }, { channel: 'email', to: data.b.email },
  ];
  for (const t of targets) {
    if (!t.to || !data.channels.includes(t.channel)) continue;
    await sendTransactional({ channel: t.channel, to: t.to, subject: data.tenant, body: tpl.ar(ctx), templateKey: ev.topic, locale: 'ar', tenantId: ev.tenantId, dedupeKey: `${ev.id}:${t.channel}` });
  }
}

for (const topic of Object.keys(TEMPLATES)) registerOutbox(topic, deliverBookingMessage);

/** 24-hour reminders, enqueued once per booking. */
registerPeriodic({
  name: 'booking.reminders-24h',
  everySec: 900,
  run: async () => {
    const due = await withSystem('find bookings needing reminders', (trx) => trx.selectFrom('bookings').select(['id', 'tenant_id'])
      .where('status', '=', 'confirmed').where('starts_at', '>', sql<Date>`now() + interval '23 hours'`).where('starts_at', '<=', sql<Date>`now() + interval '24 hours'`).limit(1000).execute());
    for (const d of due) {
      await withTenant(d.tenant_id, (trx) => enqueue(trx, 'booking.reminder', { booking_id: d.id }, { tenantId: d.tenant_id, dedupeKey: `reminder:24h:${d.id}` }));
    }
  },
});

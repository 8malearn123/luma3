import { DateTime } from 'luxon';
import { z } from 'zod';
import { sql, withSystem, withTenant, type Tx } from '../../db/client';
import { Errors } from '../../http/errors';
import { audit, type AuditActor } from '../../infra/audit';
import { channelStatus, sendTransactional, type Channel } from '../../infra/messaging';
import { notifyUsers } from '../../infra/notify';
import { hasCapability, type TenantAccess } from '../../tenancy/access';
import { formatMoney } from '@/shared/format';

/**
 * Weekly owner digest. The owner picks the weekday and business-local hour (or
 * switches it off) in settings. A periodic task checks every 15 minutes; on
 * the chosen day, from the chosen hour, it builds ONE digest per week (unique
 * on tenant + period end) covering the previous seven local days: bookings,
 * revenue, top services, staff performance, low stock and the coming week.
 * Delivered in-app (notification linking to /app/{slug}/digest/{id}) and by
 * WhatsApp/email only when a real messaging provider is connected.
 */
export const digestSettingsInput = z.object({
  enabled: z.boolean(),
  weekday: z.number().int().min(0).max(6),
  hour: z.number().int().min(0).max(23),
}).strict();
export type DigestSettings = z.infer<typeof digestSettingsInput>;

export type DigestPeriod = { period_start: string; period_end: string };

/** Pure schedule check: is a digest due at `now`, and for which period? (weekday 0 = Sunday). */
export function digestDue(s: DigestSettings, tz: string, now: Date): DigestPeriod | null {
  if (!s.enabled) return null;
  const local = DateTime.fromJSDate(now, { zone: tz });
  if (local.weekday % 7 !== s.weekday || local.hour < s.hour) return null;
  return lastSevenDays(tz, now);
}

export function lastSevenDays(tz: string, now: Date): DigestPeriod {
  const end = DateTime.fromJSDate(now, { zone: tz }).startOf('day').minus({ days: 1 });
  return { period_start: end.minus({ days: 6 }).toISODate()!, period_end: end.toISODate()! };
}

/** Next scheduled run (for the settings screen). */
export function nextDigestAt(s: DigestSettings, tz: string, now: Date): string | null {
  if (!s.enabled) return null;
  let d = DateTime.fromJSDate(now, { zone: tz }).startOf('hour');
  for (let i = 0; i < 24 * 8; i++) {
    if (d.weekday % 7 === s.weekday && d.hour === s.hour && d.toMillis() > now.getTime() - 3_600_000) return d.toISO();
    d = d.plus({ hours: 1 });
  }
  return null;
}

export async function getDigestSettings(access: TenantAccess) {
  const s = await withTenant(access.tenantId, (trx) => trx.selectFrom('tenant_settings').select(['digest_enabled', 'digest_weekday', 'digest_hour']).where('tenant_id', '=', access.tenantId).executeTakeFirstOrThrow());
  const settings = { enabled: s.digest_enabled, weekday: s.digest_weekday, hour: s.digest_hour };
  return { ...settings, timezone: access.timezone, next_at: nextDigestAt(settings, access.timezone, new Date()), messaging: { whatsapp: channelStatus('whatsapp'), email: channelStatus('email') } };
}

export async function saveDigestSettings(access: TenantAccess, actor: AuditActor, input: DigestSettings) {
  await withTenant(access.tenantId, async (trx) => {
    await trx.updateTable('tenant_settings').set({ digest_enabled: input.enabled, digest_weekday: input.weekday, digest_hour: input.hour }).where('tenant_id', '=', access.tenantId).execute();
    await audit(trx, actor, 'settings.digest_updated', { tenantId: access.tenantId, targetType: 'tenant_settings', targetId: access.tenantId, data: input });
  });
  return getDigestSettings(access);
}

// ── Building ────────────────────────────────────────────────────────────────
const ACTIVE = ['confirmed', 'checked_in', 'in_service', 'completed'] as const;

function bounds(tz: string, from: string, to: string) {
  return { start: DateTime.fromISO(from, { zone: tz }).startOf('day').toJSDate(), end: DateTime.fromISO(to, { zone: tz }).plus({ days: 1 }).startOf('day').toJSDate() };
}

async function weekFigures(trx: Tx, tenantId: string, tz: string, from: string, to: string) {
  const { start, end } = bounds(tz, from, to);
  const b = await sql<{ total: number; completed: number; cancelled: number; no_show: number; created: number; value: number }>`
    select count(*) filter (where status = any(${[...ACTIVE]}::text[]))::int as total,
           count(*) filter (where status = 'completed')::int as completed,
           count(*) filter (where status = 'cancelled')::int as cancelled,
           count(*) filter (where status = 'no_show')::int as no_show,
           (select count(*) from bookings x where x.tenant_id = ${tenantId} and x.created_at >= ${start} and x.created_at < ${end} and x.status <> 'expired')::int as created,
           coalesce(sum(total_minor) filter (where status = 'completed'), 0)::bigint as value
    from bookings where tenant_id = ${tenantId} and starts_at >= ${start} and starts_at < ${end}`.execute(trx);
  const p = await sql<{ v: number }>`select coalesce(sum(amount_minor), 0)::bigint as v from payments
    where tenant_id = ${tenantId} and status = 'captured' and captured_at >= ${start} and captured_at < ${end}`.execute(trx);
  const r = b.rows[0]!;
  return { bookings: r.total, completed: r.completed, cancelled: r.cancelled, no_show: r.no_show, new_bookings: r.created, completed_value_minor: Number(r.value), collections_minor: Number(p.rows[0]?.v ?? 0) };
}

export async function buildDigest(trx: Tx, tenantId: string, tz: string, period: DigestPeriod) {
  const { start, end } = bounds(tz, period.period_start, period.period_end);
  const prevEnd = DateTime.fromISO(period.period_start).minus({ days: 1 }).toISODate()!;
  const prevStart = DateTime.fromISO(prevEnd).minus({ days: 6 }).toISODate()!;
  const [current, previous] = [await weekFigures(trx, tenantId, tz, period.period_start, period.period_end), await weekFigures(trx, tenantId, tz, prevStart, prevEnd)];
  const top = await sql<{ service_id: string; name_ar: string | null; name_en: string | null; n: number; v: number }>`
    select i.service_id, max(i.service_name_ar) as name_ar, max(i.service_name_en) as name_en, count(*)::int as n, coalesce(sum(i.line_total_minor), 0)::bigint as v
    from booking_items i join bookings b on b.id = i.booking_id
    where i.tenant_id = ${tenantId} and i.superseded_at is null and i.starts_at >= ${start} and i.starts_at < ${end} and b.status = any(${[...ACTIVE]}::text[])
    group by i.service_id order by count(*) desc, sum(i.line_total_minor) desc limit 5`.execute(trx);
  const staff = await sql<{ staff_id: string; name: string; completed: number; no_show: number; v: number; rating: number | null; reviews: number }>`
    select sp.id as staff_id, sp.display_name as name,
      count(distinct b.id) filter (where b.status = 'completed')::int as completed,
      count(distinct b.id) filter (where b.status = 'no_show')::int as no_show,
      coalesce(sum(i.line_total_minor) filter (where b.status = 'completed'), 0)::bigint as v,
      (select avg(r.rating)::float from reviews r where r.tenant_id = ${tenantId} and r.staff_id = sp.id and r.status = 'published' and r.created_at >= ${start} and r.created_at < ${end}) as rating,
      (select count(*)::int from reviews r where r.tenant_id = ${tenantId} and r.staff_id = sp.id and r.status = 'published' and r.created_at >= ${start} and r.created_at < ${end}) as reviews
    from staff_profiles sp
    join booking_items i on i.staff_id = sp.id and i.superseded_at is null and i.starts_at >= ${start} and i.starts_at < ${end}
    join bookings b on b.id = i.booking_id
    where sp.tenant_id = ${tenantId}
    group by sp.id, sp.display_name order by 3 desc, 5 desc limit 10`.execute(trx);
  const low = await trx.selectFrom('inventory_items').select(['id', 'name', 'unit', sql<number>`on_hand - reserved`.as('available'), 'low_stock_threshold'])
    .where('tenant_id', '=', tenantId).where('is_active', '=', true).where('low_stock_threshold', 'is not', null)
    .where(sql<boolean>`on_hand - reserved <= low_stock_threshold`).orderBy('name').limit(20).execute();
  const nextFrom = DateTime.fromISO(period.period_end).plus({ days: 1 }).toISODate()!;
  const nextTo = DateTime.fromISO(nextFrom).plus({ days: 6 }).toISODate()!;
  const nb = bounds(tz, nextFrom, nextTo);
  const upcoming = await sql<{ day: string; n: number; v: number }>`
    select to_char(starts_at at time zone ${tz}, 'YYYY-MM-DD') as day, count(*)::int as n, coalesce(sum(total_minor), 0)::bigint as v from bookings
    where tenant_id = ${tenantId} and starts_at >= ${nb.start} and starts_at < ${nb.end} and status in ('confirmed', 'pending_approval', 'pending_payment')
    group by 1 order by 1`.execute(trx);
  const days = Array.from({ length: 7 }, (_, i) => DateTime.fromISO(nextFrom).plus({ days: i }).toISODate()!);
  return {
    version: 1,
    period, timezone: tz,
    bookings: { ...current, previous: { bookings: previous.bookings, completed: previous.completed, new_bookings: previous.new_bookings } },
    revenue: { completed_value_minor: current.completed_value_minor, collections_minor: current.collections_minor, previous_collections_minor: previous.collections_minor, previous_completed_value_minor: previous.completed_value_minor },
    top_services: top.rows.map((x) => ({ service_id: x.service_id, name_ar: x.name_ar, name_en: x.name_en, bookings: x.n, value_minor: Number(x.v) })),
    staff: staff.rows.map((x) => ({ staff_id: x.staff_id, name: x.name, completed: x.completed, no_show: x.no_show, value_minor: Number(x.v), rating: x.rating, reviews: x.reviews })),
    low_stock: low.map((x) => ({ id: x.id, name: x.name, unit: x.unit, available: Number(x.available), threshold: Number(x.low_stock_threshold) })),
    upcoming: {
      from: nextFrom, to: nextTo,
      days: days.map((d) => ({ date: d, bookings: upcoming.rows.find((u) => u.day === d)?.n ?? 0 })),
      bookings: upcoming.rows.reduce((a, u) => a + u.n, 0),
      expected_value_minor: upcoming.rows.reduce((a, u) => a + Number(u.v), 0),
    },
  };
}
export type DigestPayload = Awaited<ReturnType<typeof buildDigest>>;

function summaryText(p: DigestPayload, tenantName: string, currency: string) {
  const m = (v: number) => formatMoney(v, currency, 'ar');
  return [
    `الملخص الأسبوعي — ${tenantName} (${p.period.period_start} إلى ${p.period.period_end})`,
    `الحجوزات: ${p.bookings.bookings} (مكتملة ${p.bookings.completed}، ملغاة ${p.bookings.cancelled})`,
    `المحصّل: ${m(p.revenue.collections_minor)}`,
    p.top_services[0] ? `الخدمة الأكثر طلباً: ${p.top_services[0].name_ar ?? p.top_services[0].name_en}` : null,
    p.low_stock.length ? `أصناف منخفضة المخزون: ${p.low_stock.length}` : null,
    `حجوزات الأسبوع القادم: ${p.upcoming.bookings}`,
  ].filter(Boolean).join('\n');
}

/**
 * Creates the digest for a period if it does not exist yet, then notifies the
 * owner. Idempotent: a second call for the same period returns null.
 */
export async function createDigest(tenantId: string, period: DigestPeriod): Promise<{ id: string } | null> {
  const made = await withTenant(tenantId, async (trx) => {
    const t = await trx.selectFrom('tenants').select(['slug', 'name', 'timezone', 'currency']).where('id', '=', tenantId).executeTakeFirstOrThrow();
    const exists = await trx.selectFrom('weekly_digests').select('id').where('period_end', '=', period.period_end).executeTakeFirst();
    if (exists) return null;
    const payload = await buildDigest(trx, tenantId, t.timezone, period);
    const row = await trx.insertInto('weekly_digests').values({ tenant_id: tenantId, period_start: period.period_start, period_end: period.period_end, payload: JSON.stringify(payload) })
      .onConflict((oc) => oc.columns(['tenant_id', 'period_end']).doNothing()).returning('id').executeTakeFirst();
    if (!row) return null;
    const owner = await trx.selectFrom('tenant_memberships as m').innerJoin('users as u', 'u.id', 'm.user_id').select(['u.id', 'u.email', 'u.phone', 'u.email_verified_at', 'u.phone_verified_at'])
      .where('m.tenant_id', '=', tenantId).where('m.role', '=', 'owner').where('m.status', '=', 'active').executeTakeFirst();
    if (owner) {
      await notifyUsers(trx, tenantId, [owner.id], {
        kind: 'business.weekly_digest',
        title_ar: 'ملخصك الأسبوعي جاهز', title_en: 'Your weekly digest is ready',
        body_ar: `${payload.bookings.bookings} حجز هذا الأسبوع، و${payload.upcoming.bookings} حجز في الأسبوع القادم.`,
        body_en: `${payload.bookings.bookings} bookings this week, ${payload.upcoming.bookings} booked for next week.`,
        target_path: `/app/${t.slug}/digest/${row.id}`,
        data: { digest_id: row.id, period },
        dedupe_key: `weekly_digest:${period.period_end}`,
      });
    }
    return { id: row.id, owner, tenant: t, payload };
  });
  if (!made) return null;
  // Messaging only when a real provider is connected (never claims delivery otherwise).
  const delivered: Channel[] = [];
  const o = made.owner;
  if (o) {
    const targets: Array<{ channel: Channel; to: string | null }> = [
      { channel: 'whatsapp', to: o.phone_verified_at ? o.phone : null }, { channel: 'email', to: o.email_verified_at ? o.email : null },
    ];
    for (const tg of targets) {
      if (!tg.to || channelStatus(tg.channel) !== 'connected') continue;
      const r = await sendTransactional({ channel: tg.channel, to: tg.to, subject: `الملخص الأسبوعي — ${made.tenant.name}`, body: summaryText(made.payload, made.tenant.name, made.tenant.currency), templateKey: 'business.weekly_digest', locale: 'ar', tenantId, dedupeKey: `digest:${made.id}:${tg.channel}` });
      if (r.status === 'sent') delivered.push(tg.channel);
    }
    if (delivered.length) await withTenant(tenantId, (trx) => trx.updateTable('weekly_digests').set({ delivered_channels: delivered }).where('id', '=', made.id).execute());
  }
  return { id: made.id };
}

/** Periodic sweep: one digest per tenant per week at the owner's chosen time. */
export async function runDueDigests(now = new Date()) {
  const rows = await withSystem('find tenants for weekly digest', (trx) => trx.selectFrom('tenant_settings as s').innerJoin('tenants as t', 't.id', 's.tenant_id')
    .select(['t.id', 't.timezone', 's.digest_enabled', 's.digest_weekday', 's.digest_hour'])
    .where('s.digest_enabled', '=', true).where('t.status', 'in', ['active', 'onboarding']).execute());
  const made: string[] = [];
  for (const r of rows) {
    const due = digestDue({ enabled: r.digest_enabled, weekday: r.digest_weekday, hour: r.digest_hour }, r.timezone, now);
    if (!due) continue;
    try {
      const d = await createDigest(r.id, due);
      if (d) made.push(d.id);
    } catch (e) {
      console.error('[digest]', r.id, (e as Error).message);
    }
  }
  return made;
}

// ── Reading ─────────────────────────────────────────────────────────────────
const canMoney = (access: TenantAccess) => hasCapability(access, ['bookings.view_financial', 'finance.view']);

/** Money figures are removed for viewers without financial access. */
export function stripDigestMoney(p: DigestPayload): DigestPayload {
  return {
    ...p,
    bookings: { ...p.bookings, completed_value_minor: null as never, collections_minor: null as never },
    revenue: null as never,
    top_services: p.top_services.map((s) => ({ ...s, value_minor: null as never })),
    staff: p.staff.map((s) => ({ ...s, value_minor: null as never })),
    upcoming: { ...p.upcoming, expected_value_minor: null as never },
  };
}

export async function listDigests(access: TenantAccess) {
  return withTenant(access.tenantId, (trx) => trx.selectFrom('weekly_digests').select(['id', 'period_start', 'period_end', 'created_at', 'delivered_channels'])
    .orderBy('period_end', 'desc').limit(52).execute());
}

export async function getDigest(access: TenantAccess, id: string) {
  const row = await withTenant(access.tenantId, (trx) => trx.selectFrom('weekly_digests').selectAll().where('id', '=', id).executeTakeFirst());
  if (!row) throw Errors.notFound('digest');
  const payload = row.payload as unknown as DigestPayload;
  return { id: row.id, period_start: row.period_start, period_end: row.period_end, created_at: row.created_at, delivered_channels: row.delivered_channels, money: canMoney(access), payload: canMoney(access) ? payload : stripDigestMoney(payload) };
}

/** "Generate now" for the last seven days (idempotent per period). */
export async function generateDigestNow(access: TenantAccess, actor: AuditActor) {
  const period = lastSevenDays(access.timezone, new Date());
  const made = await createDigest(access.tenantId, period);
  const id = made?.id ?? (await withTenant(access.tenantId, (trx) => trx.selectFrom('weekly_digests').select('id').where('period_end', '=', period.period_end).executeTakeFirstOrThrow())).id;
  await withTenant(access.tenantId, (trx) => audit(trx, actor, 'digest.generated', { tenantId: access.tenantId, targetType: 'weekly_digest', targetId: id, data: { ...period, created: !!made } }));
  return { id, created: !!made };
}

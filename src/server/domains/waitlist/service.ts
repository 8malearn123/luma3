import { DateTime } from 'luxon';
import { sql } from 'kysely';
import type { z } from 'zod';
import { db, withSystem, withTenant, type Tx } from '../../db/client';
import { AppError, Errors } from '../../http/errors';
import { audit, type AuditActor } from '../../infra/audit';
import { notifyUsers } from '../../infra/notify';
import type { SessionUser } from '../../auth/service';
import { requireFeature, type TenantAccess } from '../../tenancy/access';
import { ensureTenantCustomerForUser } from '../customers/relationship';
import { itinerariesForDate } from '../booking/engine';
import { loadEngineInput, resolveItems } from '../booking/loader';
import { createHold } from '../booking/service';
import type { waitlistJoinInput } from '@/shared/schemas/waitlist';

/**
 * Waitlist (spec §24). Declared ranking policy: entries are ranked by request
 * time (first come, first served); among equal candidates, those who asked for
 * the freed specialist come first. Only entries with notification consent are
 * offered. Exactly one live offer exists per opening (DB unique index), each
 * time-limited; accepting requires an atomic hold, so an opening is never
 * confirmed for more than one person.
 */
export async function joinWaitlist(tenantId: string, user: SessionUser | null, input: z.infer<typeof waitlistJoinInput>, opts: { tenantCustomerId?: string; actor: AuditActor; access?: TenantAccess }) {
  if (input.desired_to < input.desired_from) throw Errors.invalid('invalid_range');
  return withTenant(tenantId, async (trx) => {
    const svc = await trx.selectFrom('services').select(['id', 'is_active', 'archived_at', 'branch_id']).where('id', '=', input.service_id).executeTakeFirst();
    if (!svc || !svc.is_active || svc.archived_at) throw Errors.invalid('service_unavailable');
    const branch = input.branch_id ?? svc.branch_id ?? (await trx.selectFrom('branches').select('id').where('is_primary', '=', true).executeTakeFirstOrThrow()).id;
    const tcId = opts.tenantCustomerId ?? (user ? await ensureTenantCustomerForUser(trx, tenantId, { userId: user.userId, displayName: user.displayName, phone: user.phone, email: user.email }) : null);
    if (!tcId) throw Errors.unauthenticated();
    const tc = await trx.selectFrom('tenant_customers').select(['id', 'user_id']).where('id', '=', tcId).executeTakeFirst();
    if (!tc) throw Errors.notFound('customer');
    const tz = (await trx.selectFrom('branches').select('timezone').where('id', '=', branch).executeTakeFirstOrThrow()).timezone;
    const dup = await trx.selectFrom('waitlist_entries').select('id').where('tenant_customer_id', '=', tcId).where('service_id', '=', input.service_id)
      .where('status', 'in', ['active', 'offered']).where('desired_to', '>=', input.desired_from).where('desired_from', '<=', input.desired_to).executeTakeFirst();
    if (dup) throw Errors.conflict('already_waitlisted', 'You are already on the waitlist for this service in these dates');
    const row = await trx.insertInto('waitlist_entries').values({
      tenant_id: tenantId, branch_id: branch, service_id: input.service_id, staff_id: input.staff_id ?? null, tenant_customer_id: tcId, customer_user_id: tc.user_id,
      desired_from: input.desired_from, desired_to: input.desired_to, time_windows: JSON.stringify(input.time_windows ?? []), notify_consent: input.notify_consent,
      expires_at: DateTime.fromISO(input.desired_to, { zone: tz }).endOf('day').toJSDate(),
    }).returningAll().executeTakeFirstOrThrow();
    await audit(trx, opts.actor, 'waitlist.joined', { tenantId, targetType: 'waitlist_entry', targetId: row.id });
    return row;
  });
}

function windowMatches(entry: { time_windows: unknown }, start: DateTime) {
  const windows = (entry.time_windows as Array<{ weekday?: number; from: string; to: string }>) ?? [];
  if (!windows.length) return true;
  const hm = start.toFormat('HH:mm');
  return windows.some((w) => (w.weekday == null || w.weekday === start.weekday % 7) && w.from <= hm && hm < w.to);
}

/**
 * Called when a booking frees time (cancel / no-show / reschedule). Finds the
 * best-ranked consenting entry whose service can actually fit in the freed time
 * with that specialist, and issues a single time-limited offer.
 */
export async function offerFreedSlot(trx: Tx, tenantId: string, bookingId: string) {
  const items = await trx.selectFrom('booking_items').select(['staff_id', 'starts_at', 'ends_at']).where('booking_id', '=', bookingId).execute();
  if (!items.length) return [];
  const settings = await trx.selectFrom('tenant_settings').select(['waitlist_offer_ttl_min']).where('tenant_id', '=', tenantId).executeTakeFirstOrThrow();
  const offers: string[] = [];
  for (const it of items) {
    if (it.starts_at <= new Date()) continue;
    const branch = await trx.selectFrom('bookings').select(['branch_id', 'timezone']).where('id', '=', bookingId).executeTakeFirstOrThrow();
    const day = DateTime.fromJSDate(it.starts_at, { zone: branch.timezone });
    const dayISO = day.toISODate()!;
    const candidates = await trx.selectFrom('waitlist_entries').selectAll()
      .where('status', '=', 'active').where('notify_consent', '=', true).where('expires_at', '>', new Date())
      .where('desired_from', '<=', dayISO).where('desired_to', '>=', dayISO).where('branch_id', '=', branch.branch_id)
      .where((eb) => eb.or([eb('staff_id', 'is', null), eb('staff_id', '=', it.staff_id)]))
      .orderBy(sql`case when staff_id = ${it.staff_id} then 0 else 1 end`).orderBy('created_at').limit(25).execute();
    for (const c of candidates) {
      // Can this entry's service fit at this exact time with this specialist?
      let resolved;
      try {
        resolved = await resolveItems(trx, tenantId, branch.branch_id, [{ key: 'w', serviceId: c.service_id, staffId: it.staff_id }], 'internal');
      } catch { continue; }
      const engine = await loadEngineInput(trx, tenantId, branch.branch_id, resolved, dayISO, dayISO);
      const options = itinerariesForDate(engine, resolved.map((r) => r.spec), dayISO)
        .filter((o) => o.start >= it.starts_at.getTime() && o.start < it.ends_at.getTime() && windowMatches(c, DateTime.fromMillis(o.start, { zone: branch.timezone })));
      const first = options[0];
      if (!first) continue;
      const inserted = await trx.insertInto('waitlist_offers').values({
        tenant_id: tenantId, waitlist_entry_id: c.id, staff_id: it.staff_id, slot_start: new Date(first.start), slot_end: new Date(first.end),
        rank_basis: JSON.stringify({ policy: 'fifo_prefer_requested_staff', requested_at: c.created_at, staff_match: c.staff_id === it.staff_id }),
        expires_at: new Date(Date.now() + settings.waitlist_offer_ttl_min * 60_000),
      }).onConflict((oc) => oc.columns(['tenant_id', 'staff_id', 'slot_start']).where('status', '=', 'pending').doNothing()).returning('id').executeTakeFirst();
      if (!inserted) break; // a live offer already exists for this opening
      await trx.updateTable('waitlist_entries').set({ status: 'offered' }).where('id', '=', c.id).execute();
      if (c.customer_user_id) {
        await notifyUsers(trx, tenantId, [c.customer_user_id], {
          kind: 'waitlist.offer', title_ar: 'توفر موعد من قائمة الانتظار — العرض لفترة محدودة', title_en: 'A waitlist opening is available — limited-time offer',
          target_path: `/account/waitlist/offers/${inserted.id}`, dedupe_key: `waitlist-offer:${inserted.id}`,
        });
      }
      offers.push(inserted.id);
      break;
    }
  }
  return offers;
}

/** Accepting an offer creates an atomic hold; if the time was taken meanwhile, the offer ends and the next candidate is offered. */
export async function acceptOffer(user: SessionUser, offerId: string, idempotencyKey: string, actor: AuditActor) {
  const ref = (await sql<{ tenant_id: string; tenant_slug: string }>`select * from app.waitlist_offer_ref(${user.userId}, ${offerId})`.execute(db())).rows[0];
  if (!ref) throw Errors.notFound('offer');
  const offer = await withTenant(ref.tenant_id, async (trx) => {
    const o = await trx.selectFrom('waitlist_offers as o').innerJoin('waitlist_entries as e', 'e.id', 'o.waitlist_entry_id')
      .select(['o.id', 'o.status', 'o.expires_at', 'o.slot_start', 'o.staff_id', 'e.service_id', 'e.branch_id', 'e.id as entry_id'])
      .where('o.id', '=', offerId).forUpdate().executeTakeFirstOrThrow();
    if (o.status !== 'pending') throw Errors.conflict('offer_closed', 'This offer is no longer available');
    if (o.expires_at <= new Date()) {
      await trx.updateTable('waitlist_offers').set({ status: 'expired' }).where('id', '=', offerId).execute();
      throw Errors.conflict('offer_expired', 'This offer has expired');
    }
    return o;
  });
  try {
    const hold = await createHold(ref.tenant_id, {
      branchId: offer.branch_id, items: [{ key: 'w', serviceId: offer.service_id, staffId: offer.staff_id, start: offer.slot_start.toISOString() }],
      customer: { kind: 'user', user }, source: 'waitlist', audience: 'internal', idempotencyKey, actor,
    });
    const body = hold.body as { booking_id: string };
    await withTenant(ref.tenant_id, async (trx) => {
      await trx.updateTable('waitlist_offers').set({ status: 'accepted', responded_at: new Date(), booking_id: body.booking_id }).where('id', '=', offerId).execute();
      await trx.updateTable('waitlist_entries').set({ status: 'fulfilled' }).where('id', '=', offer.entry_id).execute();
    });
    return { ...body, tenant_slug: ref.tenant_slug };
  } catch (e) {
    if (e instanceof AppError && e.status === 409) {
      await withTenant(ref.tenant_id, async (trx) => {
        await trx.updateTable('waitlist_offers').set({ status: 'superseded', responded_at: new Date() }).where('id', '=', offerId).execute();
        await trx.updateTable('waitlist_entries').set({ status: 'active' }).where('id', '=', offer.entry_id).execute();
      });
    }
    throw e;
  }
}

/** The customer's own offer (the slot, specialist, expiry). Another customer's offer is a 404. */
export async function getOfferForCustomer(user: SessionUser, offerId: string) {
  const ref = (await sql<{ tenant_id: string; tenant_slug: string }>`select * from app.waitlist_offer_ref(${user.userId}, ${offerId})`.execute(db())).rows[0];
  if (!ref) throw Errors.notFound('offer');
  return withTenant(ref.tenant_id, async (trx) => {
    const o = await trx.selectFrom('waitlist_offers as o').innerJoin('waitlist_entries as e', 'e.id', 'o.waitlist_entry_id')
      .innerJoin('services as s', 's.id', 'e.service_id').innerJoin('staff_profiles as sp', 'sp.id', 'o.staff_id')
      .innerJoin('branches as br', 'br.id', 'e.branch_id').innerJoin('tenants as t', 't.id', 'o.tenant_id')
      .select(['o.id', 'o.status', 'o.slot_start', 'o.slot_end', 'o.expires_at', 'o.booking_id', 'o.responded_at', 'sp.display_name as staff_name',
        's.name_ar as service_name_ar', 's.name_en as service_name_en', 's.price_minor', 's.price_display', 'br.timezone', 't.name as tenant_name'])
      .where('o.id', '=', offerId).executeTakeFirstOrThrow();
    // A pending offer past its TTL is reported as expired even before the sweeper runs.
    const status = o.status === 'pending' && o.expires_at <= new Date() ? 'expired' : o.status;
    return { ...o, status, tenant_slug: ref.tenant_slug };
  });
}

export async function declineOffer(user: SessionUser, offerId: string) {
  const ref = (await sql<{ tenant_id: string }>`select * from app.waitlist_offer_ref(${user.userId}, ${offerId})`.execute(db())).rows[0];
  if (!ref) throw Errors.notFound('offer');
  return withTenant(ref.tenant_id, async (trx) => {
    const o = await trx.updateTable('waitlist_offers').set({ status: 'declined', responded_at: new Date() }).where('id', '=', offerId).where('status', '=', 'pending')
      .returning(['waitlist_entry_id']).executeTakeFirst();
    if (!o) throw Errors.conflict('offer_closed');
    await trx.updateTable('waitlist_entries').set({ status: 'active' }).where('id', '=', o.waitlist_entry_id).execute();
    return { declined: true };
  });
}

/** Expires offers past their TTL and passes the opening to the next candidate. */
export async function expireOffers() {
  const due = await withSystem('find expired waitlist offers', (trx) => trx.selectFrom('waitlist_offers as o').innerJoin('waitlist_entries as e', 'e.id', 'o.waitlist_entry_id')
    .select(['o.id', 'o.tenant_id', 'o.waitlist_entry_id']).where('o.status', '=', 'pending').where('o.expires_at', '<=', new Date()).limit(200).execute());
  for (const d of due) {
    await withTenant(d.tenant_id, async (trx) => {
      const r = await trx.updateTable('waitlist_offers').set({ status: 'expired' }).where('id', '=', d.id).where('status', '=', 'pending').returning('id').executeTakeFirst();
      if (r) await trx.updateTable('waitlist_entries').set({ status: 'active' }).where('id', '=', d.waitlist_entry_id).where('status', '=', 'offered').execute();
    });
  }
  await withSystem('expire waitlist entries', (trx) => trx.updateTable('waitlist_entries').set({ status: 'expired' }).where('status', 'in', ['active']).where('expires_at', '<=', new Date()).execute());
  return due.length;
}

export async function listWaitlist(access: TenantAccess, status?: string) {
  requireFeature(access, 'feature.waitlist');
  return withTenant(access.tenantId, async (trx) => {
    let q = trx.selectFrom('waitlist_entries as e').innerJoin('tenant_customers as c', 'c.id', 'e.tenant_customer_id').innerJoin('services as s', 's.id', 'e.service_id')
      .leftJoin('staff_profiles as sp', 'sp.id', 'e.staff_id')
      .select(['e.id', 'e.status', 'e.desired_from', 'e.desired_to', 'e.time_windows', 'e.notify_consent', 'e.created_at', 'e.expires_at', 'e.staff_id', 'sp.display_name as staff_name',
        'c.display_name as customer_name', 's.name_ar as service_name_ar', 's.name_en as service_name_en',
        sql<number>`(select count(*)::int from waitlist_offers o where o.waitlist_entry_id = e.id)`.as('offers')]);
    if (status) q = q.where('e.status', '=', status);
    const rows = await q.orderBy('e.created_at').limit(300).execute();
    // The most recent offer per entry (the offered slot and when it expires).
    const offers = rows.length ? await trx.selectFrom('waitlist_offers as o').innerJoin('staff_profiles as sp', 'sp.id', 'o.staff_id')
      .select(['o.id', 'o.waitlist_entry_id', 'o.status', 'o.slot_start', 'o.slot_end', 'o.expires_at', 'o.responded_at', 'o.created_at', 'sp.display_name as staff_name'])
      .where('o.waitlist_entry_id', 'in', rows.map((r) => r.id)).orderBy('o.created_at', 'desc').execute() : [];
    return rows.map((r) => {
      const o = offers.find((x) => x.waitlist_entry_id === r.id);
      return { ...r, latest_offer: o ? { id: o.id, status: o.status, slot_start: o.slot_start, slot_end: o.slot_end, expires_at: o.expires_at, responded_at: o.responded_at, staff_name: o.staff_name } : null };
    });
  });
}

export async function cancelEntry(access: TenantAccess, actor: AuditActor, entryId: string) {
  return withTenant(access.tenantId, async (trx) => {
    const r = await trx.updateTable('waitlist_entries').set({ status: 'cancelled' }).where('id', '=', entryId).where('status', 'in', ['active', 'offered']).returning('id').executeTakeFirst();
    if (!r) throw Errors.notFound('waitlist_entry');
    await trx.updateTable('waitlist_offers').set({ status: 'superseded' }).where('waitlist_entry_id', '=', entryId).where('status', '=', 'pending').execute();
    await audit(trx, actor, 'waitlist.cancelled', { tenantId: access.tenantId, targetType: 'waitlist_entry', targetId: entryId });
    return r;
  });
}

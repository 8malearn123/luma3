import { sql } from 'kysely';
import { db } from '../../db/client';
import { Errors } from '../../http/errors';

/** Resolves the tenant of a booking that belongs to this customer, or 404. */
export async function customerBookingTenant(userId: string, bookingId: string) {
  const r = await sql<{ tenant_id: string; tenant_slug: string }>`select * from app.customer_booking_ref(${userId}, ${bookingId})`.execute(db());
  const row = r.rows[0];
  if (!row) throw Errors.notFound('booking');
  return row;
}

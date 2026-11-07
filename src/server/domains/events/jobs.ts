import { withSystem, withTenant } from '../../db/client';
import { registerPeriodic } from '../../jobs/registry';
import { expireEventTimeouts } from './service';
import { syncInstagram } from '../instagram/service';

/**
 * Expert experience background tasks:
 *  - events.expire: lapsed deposit checkouts free the held time; lapsed quotes expire.
 *    (Also done lazily on every read, so this only keeps lists tidy.)
 *  - instagram.sync: refreshes cached posts of connected accounts (official API only).
 */
registerPeriodic({
  name: 'events.expire',
  everySec: 120,
  run: async () => {
    const now = new Date();
    const rows = await withSystem('find lapsed event bookings', (trx) => trx.selectFrom('event_bookings').select(['id', 'tenant_id'])
      .where((eb) => eb.or([
        eb.and([eb('status', '=', 'pending_payment'), eb('payment_expires_at', '<=', now)]),
        eb.and([eb('status', '=', 'quoted'), eb('quote_expires_at', '<=', now)]),
      ])).limit(500).execute());
    for (const r of rows) await withTenant(r.tenant_id, (trx) => expireEventTimeouts(trx, r.id));
  },
});

registerPeriodic({
  name: 'instagram.sync',
  everySec: 6 * 3600,
  run: async () => {
    const rows = await withSystem('find connected instagram accounts', (trx) => trx.selectFrom('instagram_connections').select('tenant_id').where('status', 'in', ['connected', 'error']).execute());
    for (const r of rows) await syncInstagram(r.tenant_id);
  },
});

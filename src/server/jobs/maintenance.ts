import { sql } from 'kysely';
import { withSystem } from '../db/client';
import { registerPeriodic } from './registry';

registerPeriodic({
  name: 'expire-idempotency-and-rate-limits',
  everySec: 3600,
  run: async () => {
    await withSystem('cleanup', async (trx) => {
      await trx.deleteFrom('idempotency_records').where('expires_at', '<', new Date()).execute();
      await sql`delete from rate_limit_buckets where window_start < now() - interval '1 day'`.execute(trx);
      await sql`delete from verification_codes where expires_at < now() - interval '7 days'`.execute(trx);
    });
  },
});

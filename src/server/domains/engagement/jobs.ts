import { withSystem } from '../../db/client';
import { registerPeriodic } from '../../jobs/registry';
import { expireInactivePoints } from '../loyalty/service';
import { expireGiftCards } from '../giftcards/service';

registerPeriodic({ name: 'loyalty.expire-inactive', everySec: 6 * 3600, run: async () => { await expireInactivePoints(); } });
registerPeriodic({ name: 'giftcards.expire', everySec: 3600, run: async () => { await expireGiftCards(); } });
registerPeriodic({
  name: 'memberships.expire',
  everySec: 3600,
  run: async () => {
    await withSystem('expire memberships', (trx) => trx.updateTable('customer_memberships').set({ status: 'expired' }).where('status', '=', 'active').where('ends_at', '<=', new Date()).execute());
  },
});
